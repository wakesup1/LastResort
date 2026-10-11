"""LR-D03: disposable PostgreSQL experiment; Python standard library only.

Requires initdb, pg_ctl and psql on PATH. Creates and stops its own database.
It never connects to an existing application database.
"""

import concurrent.futures
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time


def main():
    for program in ("initdb", "pg_ctl", "psql"):
        if not shutil.which(program):
            raise SystemExit(f"Required executable missing: {program}")

    with tempfile.TemporaryDirectory(prefix="lastresort-inventory-") as directory:
        root = Path(directory)
        data = root / "data"
        socket = root / "socket"
        socket.mkdir()
        env = {**os.environ, "PGHOST": str(socket), "PGPORT": "55439",
               "PGDATABASE": "postgres", "PGUSER": "lastresort_spike",
               "PGCONNECT_TIMEOUT": "5"}
        # Remove connection service overrides; this experiment uses only its cluster.
        for key in ("PGSERVICE", "PGSERVICEFILE", "PGOPTIONS", "PGPASSWORD"):
            env.pop(key, None)

        def sql(statement, application="lastresort_spike_inspector", check=True):
            return subprocess.run(
                ["psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", statement],
                env={**env, "PGAPPNAME": application}, text=True,
                capture_output=True, check=check, timeout=15,
            )

        def scalar(statement):
            return sql(statement).stdout.strip()

        def wait_for(application, condition):
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                if scalar(f"SELECT count(*) FROM pg_stat_activity WHERE "
                          f"application_name = '{application}' AND {condition}") == "1":
                    return
                time.sleep(0.025)
            raise AssertionError(f"Did not observe {application}: {condition}")

        subprocess.run(["initdb", "-D", str(data), "-U", "lastresort_spike",
                        "--auth-local=trust", "--auth-host=reject", "--no-locale"],
                       check=True, capture_output=True, text=True, timeout=30)
        started = False
        try:
            subprocess.run(["pg_ctl", "-D", str(data), "-l", str(root / "postgres.log"),
                            "-o", f"-k {socket} -p 55439 -c listen_addresses=''",
                            "-w", "start"], check=True, capture_output=True,
                           text=True, timeout=30)
            started = True
            sql("""
                CREATE TABLE inventory (
                    id integer PRIMARY KEY,
                    capacity integer NOT NULL CHECK (capacity >= 0),
                    remaining integer NOT NULL CHECK (remaining BETWEEN 0 AND capacity)
                );
                CREATE TABLE reservations (
                    id integer PRIMARY KEY,
                    event_id integer NOT NULL REFERENCES inventory(id),
                    owner text NOT NULL CHECK (owner <> '')
                );
                INSERT INTO inventory VALUES (1, 1, 1);
            """)

            def reservation(number, owner):
                # INSERT can only happen if the guarded decrement returns a row.
                return f"""
                    WITH acquired AS (
                        UPDATE inventory SET remaining = remaining - 1
                        WHERE id = 1 AND remaining > 0 RETURNING id
                    )
                    INSERT INTO reservations (id, event_id, owner)
                    SELECT {number}, id, '{owner}' FROM acquired RETURNING id;
                """

            results = []
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
                first = executor.submit(sql, "BEGIN; " + reservation(1, "guest_a") +
                                        "SELECT pg_sleep(2); COMMIT;", "lastresort_spike_a")
                wait_for("lastresort_spike_a", "wait_event = 'PgSleep'")
                second = executor.submit(sql, "BEGIN; " + reservation(2, "guest_b") +
                                         "COMMIT;", "lastresort_spike_b")
                wait_for("lastresort_spike_b", "wait_event_type = 'Lock'")
                first.result()
                second_result = second.result()
                assert second_result.stdout.strip() == "", "Second request acquired a ticket"
            assert scalar("SELECT remaining FROM inventory WHERE id=1") == "0"
            assert scalar("SELECT count(*) FROM reservations") == "1"
            results.append({"case": "two_overlapping_requests_one_ticket",
                            "passed": True, "lock_wait_observed": True,
                            "confirmed": 1, "remaining": 0})

            sql("TRUNCATE reservations; UPDATE inventory SET remaining=1 WHERE id=1;")
            failed = sql("BEGIN; " + reservation(3, "") + "COMMIT;", check=False)
            assert failed.returncode != 0, "Expected reservation insert to fail"
            assert 'reservations_owner_check' in failed.stderr, failed.stderr
            assert scalar("SELECT remaining FROM inventory WHERE id=1") == "1"
            assert scalar("SELECT count(*) FROM reservations") == "0"
            sql("BEGIN; " + reservation(4, "guest_after_failure") + "COMMIT;")
            assert scalar("SELECT remaining FROM inventory WHERE id=1") == "0"
            assert scalar("SELECT count(*) FROM reservations") == "1"
            results.append({"case": "insert_failure_rolls_back_decrement",
                            "passed": True, "remaining_after_failure": 1,
                            "confirmed_after_failure": 0, "subsequent_request_succeeded": True})

            print(json.dumps({"backlog_id": "LR-D03", "database": scalar("SELECT version()"),
                              "isolation": scalar("SHOW default_transaction_isolation"),
                              "workload": "two overlapping database transactions; one ticket",
                              "results": results}, indent=2))
        finally:
            if started:
                subprocess.run(["pg_ctl", "-D", str(data), "-m", "fast", "-w", "stop"],
                               check=True, capture_output=True, text=True, timeout=30)


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        raise SystemExit(error.stderr or error.stdout or str(error)) from error
