import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { BOOKING_STORAGE_KEY, createBookingController, isReservation } from "../src/app/_lib/booking.ts";
import { assertDisposableDatabase, readConfig } from "../src/server/config.ts";
import { writeJson } from "./concurrency-evidence.ts";

type Snapshot = { capacity: number; remaining: number; confirmed: number; operations: number; incomplete: number };
type Case = { scenario: string; status: "running" | "passed" | "failed"; phase: string; snapshots: Snapshot[] };

async function until(check: () => Promise<boolean>, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(20);
  }
  throw new Error("Verification deadline exceeded.");
}

async function availablePort() {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function stop(child: ChildProcess | undefined, signal: "SIGTERM" | "SIGKILL") {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill(signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([exited, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Server did not exit.")), 5000);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

async function main() {
  const directory = join(process.cwd(), "test-results", "failure-recovery", `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`);
  const reportPath = join(directory, "summary.json");
  const report = {
    task: "S2-08", revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    workingTreeDirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0,
    environment: { node: process.version, platform: process.platform, architecture: process.arch, postgres: null as string | null },
    workload: { scenarios: 3, capacityPerEvent: 1, transport: "local production HTTP", restart: "application SIGKILL; database stays running" },
    startedAt: new Date().toISOString(), finishedAt: null as string | null,
    status: "running" as "running" | "passed" | "failed", phase: "preflight", cases: [] as Case[],
    serverStarts: 0, cleanupCompleted: false,
  };
  await writeJson(reportPath, report);
  let pool: Pool | undefined;
  let server: ChildProcess | undefined;
  const eventIds: string[] = [];
  const tokenHashes: string[] = [];
  // Identifiers contain only a fixed prefix and a generated hexadecimal suffix.
  const fixtureName = `failure_${randomUUID().replaceAll("-", "")}`;
  let fixturesAllowed = false;
  let origin = "";
  let port = 0;
  try {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    assert.ok(databaseUrl, "Use a dedicated disposable TEST_DATABASE_URL.");
    const config = readConfig({ APP_ENV: "test", DATABASE_URL: databaseUrl });
    const database = new Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 3000, statement_timeout: 10000 });
    pool = database;
    const info = await database.query<{ name: string; version: number; version_text: string }>(
      "SELECT current_database() AS name, current_setting('server_version_num')::int AS version, current_setting('server_version') AS version_text",
    );
    const state = info.rows[0];
    assert.ok(state && Math.floor(state.version / 10000) === 17);
    assertDisposableDatabase(config, state.name);
    const marker = await database.query<{ name: string }>("SELECT name FROM lastresort.environment WHERE id=1");
    assert.ok(marker.rows[0]);
    assertDisposableDatabase(config, state.name, marker.rows[0].name);
    report.environment.postgres = state.version_text;
    fixturesAllowed = true;
    port = await availablePort();
    origin = `http://127.0.0.1:${port}`;

    async function start() {
      server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
        env: { ...process.env, APP_ENV: "test", DATABASE_URL: databaseUrl, APP_ORIGIN: "", NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" },
        // Raw server output may contain sensitive values. Evidence contains allowlisted state only.
        stdio: "ignore",
      });
      const child = server;
      let spawnFailed = false;
      child.once("error", () => { spawnFailed = true; });
      report.serverStarts += 1;
      await until(async () => {
        assert.ok(!spawnFailed && child.exitCode === null && child.signalCode === null);
        try { return (await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) })).status === 200; }
        catch { return false; }
      }, 30_000);
    }
    async function request(path: string, cookie: string, key?: string, eventId?: string) {
      const response = await fetch(`${origin}${path}`, {
        method: key ? "POST" : "GET",
        headers: { Cookie: cookie, ...(key ? { Origin: origin, "Content-Type": "application/json", "Idempotency-Key": key } : {}) },
        ...(key ? { body: JSON.stringify({ eventId, quantity: 1 }) } : {}),
        signal: AbortSignal.timeout(10000),
      });
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.has("set-cookie"), false);
      return response;
    }
    async function error(response: Response, status: number, code: string) {
      assert.equal(response.status, status);
      const body: unknown = await response.json();
      assert.ok(typeof body === "object" && body !== null && "error" in body && typeof body.error === "object" && body.error !== null && "code" in body.error);
      assert.equal(body.error.code, code);
    }
    async function session() {
      const response = await fetch(`${origin}/api/session`, { method: "POST", headers: { Origin: origin }, signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 204);
      const cookie = response.headers.get("set-cookie")?.split(";")[0];
      assert.ok(cookie);
      tokenHashes.push(createHash("sha256").update(cookie.slice(cookie.indexOf("=") + 1)).digest("hex"));
      return cookie;
    }
    async function fixture() {
      const id = `failure-${randomUUID()}`;
      eventIds.push(id);
      await database.query(
        `INSERT INTO lastresort.events
         (id, name, starts_at, venue, ticket_type, price_minor, sale_opens_at, sale_closes_at, capacity, remaining)
         VALUES ($1, 'Failure recovery fixture', clock_timestamp()+interval '2 days', 'Test Hall', 'General admission',
                 0, clock_timestamp()-interval '1 day', clock_timestamp()+interval '1 day', 1, 1)`, [id],
      );
      return id;
    }
    async function snapshot(evidence: Case, eventId: string, remaining: number, confirmed: number, operations: number) {
      const result = await database.query<Snapshot>(
        `SELECT capacity, remaining,
          (SELECT count(*)::int FROM lastresort.reservations WHERE event_id=e.id) AS confirmed,
          (SELECT count(*)::int FROM lastresort.booking_operations WHERE event_id=e.id) AS operations,
          (SELECT count(*)::int FROM lastresort.booking_operations WHERE event_id=e.id AND response IS NULL) AS incomplete
         FROM lastresort.events e WHERE id=$1`, [eventId],
      );
      const row = result.rows[0];
      assert.ok(row);
      evidence.snapshots.push(row);
      await writeJson(reportPath, report);
      assert.deepEqual(row, { capacity: 1, remaining, confirmed, operations, incomplete: 0 });
      assert.equal(row.remaining + row.confirmed, row.capacity);
    }
    async function scenario(name: string, run: (evidence: Case) => Promise<void>) {
      const evidence: Case = { scenario: name, status: "running", phase: "setup", snapshots: [] };
      report.cases.push(evidence);
      report.phase = name;
      await writeJson(reportPath, report);
      try {
        await run(evidence);
        evidence.phase = "complete";
        evidence.status = "passed";
      } catch { evidence.status = "failed"; throw new Error("Scenario failed."); }
      finally { await writeJson(reportPath, report); }
      console.log(`Failure recovery ${name}: passed.`);
    }
    await start();
    const cookie = await session();
    const otherCookie = await session();

    await scenario("rollback-at-commit", async (evidence) => {
      const eventId = await fixture();
      const key = randomUUID();
      // A deferred trigger proves all three writes reached COMMIT, then rejects it.
      // Sequence advances survive rollback, so a generic earlier failure cannot pass this check.
      await database.query(`CREATE SEQUENCE lastresort.${fixtureName}`);
      await database.query(`CREATE FUNCTION lastresort.${fixtureName}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM lastresort.events WHERE id=NEW.event_id AND remaining=0)
             OR NOT EXISTS (SELECT 1 FROM lastresort.booking_operations WHERE event_id=NEW.event_id AND response IS NOT NULL)
          THEN RAISE EXCEPTION 'Failure fixture was reached too early'; END IF;
          PERFORM nextval('lastresort.${fixtureName}');
          RAISE EXCEPTION 'Injected deferred commit failure' USING ERRCODE='23514';
        END $$`);
      // eventId is a generated UUID fixture, never request input.
      await database.query(`CREATE CONSTRAINT TRIGGER ${fixtureName} AFTER INSERT ON lastresort.reservations
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.event_id='${eventId}') EXECUTE FUNCTION lastresort.${fixtureName}()`);
      evidence.phase = "commit-rejected";
      await error(await request("/api/reservations", cookie, key, eventId), 503, "SERVICE_UNAVAILABLE");
      assert.deepEqual((await database.query(`SELECT last_value::int, is_called FROM lastresort.${fixtureName}`)).rows,
        [{ last_value: 1, is_called: true }]);
      await snapshot(evidence, eventId, 1, 0, 0);
      await error(await request(`/api/booking-operations/${key}`, cookie), 404, "NOT_FOUND");
      await database.query(`DROP TRIGGER ${fixtureName} ON lastresort.reservations`);
      await database.query(`DROP FUNCTION lastresort.${fixtureName}()`);
      await database.query(`DROP SEQUENCE lastresort.${fixtureName}`);
      evidence.phase = "same-key-retry";
      assert.equal((await request("/api/reservations", cookie, key, eventId)).status, 201);
      assert.equal((await request("/api/reservations", cookie, key, eventId)).status, 200);
      await snapshot(evidence, eventId, 0, 1, 1);
    });

    await scenario("crash-before-commit", async (evidence) => {
      const eventId = await fixture();
      const key = randomUUID();
      const gate = await database.connect();
      let pending: Promise<Response | null> | undefined;
      try {
        const gatePid = (await gate.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        await gate.query("BEGIN");
        await gate.query("SELECT pg_advisory_xact_lock($1)", [gatePid]);
        await database.query(`CREATE FUNCTION lastresort.${fixtureName}() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NOT EXISTS (SELECT 1 FROM lastresort.events WHERE id=NEW.event_id AND remaining=0)
               OR NOT EXISTS (SELECT 1 FROM lastresort.reservations WHERE event_id=NEW.event_id)
            THEN RAISE EXCEPTION 'Failure fixture was reached too early'; END IF;
            PERFORM pg_advisory_xact_lock(TG_ARGV[0]::bigint);
            RETURN NEW;
          END $$`);
        await database.query(`CREATE TRIGGER ${fixtureName} BEFORE UPDATE ON lastresort.booking_operations
          FOR EACH ROW WHEN (NEW.event_id='${eventId}') EXECUTE FUNCTION lastresort.${fixtureName}('${gatePid}')`);
        evidence.phase = "waiting-after-writes";
        pending = request("/api/reservations", cookie, key, eventId).catch(() => null);
        let backendPid = 0;
        await until(async () => {
          const waiters = await database.query<{ pid: number }>(
            "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name='lastresort' AND $1::int=ANY(pg_blocking_pids(pid))", [gatePid],
          );
          backendPid = waiters.rows[0]?.pid ?? 0;
          return backendPid !== 0;
        }, 3000);
        await snapshot(evidence, eventId, 1, 0, 0);
        await error(await request(`/api/booking-operations/${key}`, cookie), 404, "NOT_FOUND");
        evidence.phase = "application-killed";
        await writeJson(reportPath, report);
        await stop(server, "SIGKILL");
        // Release the test gate only after killing the application. PostgreSQL then
        // detects the closed client socket and aborts the transaction on that backend.
        await gate.query("ROLLBACK");
        await until(async () => (await database.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1", [backendPid])).rows.length === 0);
        const response = await pending;
        assert.equal(response, null, "A killed application must not deliver a confirmation.");
      } finally {
        try { await gate.query("ROLLBACK"); }
        finally { gate.release(); if (pending) await pending; }
      }
      await database.query(`DROP TRIGGER ${fixtureName} ON lastresort.booking_operations`);
      await database.query(`DROP FUNCTION lastresort.${fixtureName}()`);
      await snapshot(evidence, eventId, 1, 0, 0);
      evidence.phase = "restarted";
      await start();
      await error(await request(`/api/booking-operations/${key}`, cookie), 404, "NOT_FOUND");
      assert.equal((await request("/api/reservations", cookie, key, eventId)).status, 201);
      assert.equal((await request("/api/reservations", cookie, key, eventId)).status, 200);
      await snapshot(evidence, eventId, 0, 1, 1);
    });

    await scenario("lost-response-and-restart", async (evidence) => {
      const eventId = await fixture();
      const values = new Map<string, string>();
      const storage = {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
        removeItem: (key: string) => { values.delete(key); },
      };
      const calls: string[] = [];
      let original: unknown;
      const send: typeof fetch = async (url, options) => {
        const path = String(url);
        calls.push(`${options?.method ?? "GET"} ${path}`);
        const headers = new Headers(options?.headers);
        headers.set("Origin", origin);
        headers.set("Cookie", cookie);
        const response = await fetch(`${origin}${path}`, { ...options, headers });
        if (path === "/api/reservations" && options?.method === "POST") {
          assert.equal(response.status, 201);
          original = await response.json(); // Deliberately discard a committed response at the client boundary.
          throw new TypeError("Injected response loss after commit.");
        }
        return response;
      };
      assert.deepEqual(await createBookingController(storage, send).confirm(eventId), { kind: "unknown" });
      assert.ok(isReservation(original));
      const booking = original;
      const saved = storage.getItem(BOOKING_STORAGE_KEY);
      assert.ok(saved);
      const operation: unknown = JSON.parse(saved);
      assert.ok(typeof operation === "object" && operation !== null && "operationId" in operation && typeof operation.operationId === "string");
      const key = operation.operationId;
      const rejectedKey = randomUUID();
      await error(await request("/api/reservations", cookie, rejectedKey, eventId), 409, "SOLD_OUT");
      await snapshot(evidence, eventId, 0, 1, 2);
      evidence.phase = "committed-application-killed";
      await writeJson(reportPath, report);
      await stop(server, "SIGKILL");
      const reloaded = createBookingController(storage, send);
      assert.deepEqual(reloaded.restore(), { kind: "unknown" });
      assert.deepEqual(calls, ["POST /api/session", "POST /api/reservations"]);
      assert.equal((await reloaded.check()).kind, "unknown");
      assert.equal(storage.getItem(BOOKING_STORAGE_KEY), saved);
      await database.query("UPDATE lastresort.events SET sale_closes_at=clock_timestamp()-interval '1 second' WHERE id=$1", [eventId]);
      evidence.phase = "restart-and-read-original";
      await start();
      assert.deepEqual(await reloaded.check(), { kind: "confirmed", reference: booking.reference });
      assert.deepEqual(calls, ["POST /api/session", "POST /api/reservations", `GET /api/booking-operations/${key}`, `GET /api/booking-operations/${key}`]);
      const recovered = await request(`/api/booking-operations/${key}`, cookie);
      assert.equal(recovered.status, 200);
      assert.deepEqual(await recovered.json(), { eventId, outcome: { reservation: booking } });
      const replay = await request("/api/reservations", cookie, key, eventId);
      assert.equal(replay.status, 200);
      assert.deepEqual(await replay.json(), booking);
      // Persisted rejection must survive restart and replay SOLD_OUT even after sales close.
      const rejection = await request(`/api/booking-operations/${rejectedKey}`, cookie);
      assert.equal(rejection.status, 200);
      assert.deepEqual(await rejection.json(), { eventId, outcome: { code: "SOLD_OUT" } });
      await error(await request("/api/reservations", cookie, rejectedKey, eventId), 409, "SOLD_OUT");
      const detail = await request(`/api/reservations/${booking.reference}`, cookie);
      assert.equal(detail.status, 200);
      assert.deepEqual(await detail.json(), booking);
      const history = await request("/api/reservations", cookie);
      assert.equal(history.status, 200);
      const body: unknown = await history.json();
      assert.ok(typeof body === "object" && body !== null && "reservations" in body && Array.isArray(body.reservations));
      assert.equal(body.reservations.filter((item: unknown) => isReservation(item) && item.reference === booking.reference).length, 1);
      for (const path of [`/api/booking-operations/${key}`, `/api/reservations/${booking.reference}`]) {
        await error(await request(path, otherCookie), 404, "NOT_FOUND");
        await error(await request(path, ""), 401, "SESSION_REQUIRED");
      }
      await snapshot(evidence, eventId, 0, 1, 2);
    });
    report.status = "passed";
    report.phase = "complete";
  } catch {
    report.status = "failed";
    // Never serialize exceptions, SQL, cookies, retry keys, URLs or raw child output.
    console.error(`Failure recovery verification failed at ${report.phase}. See retained stage and snapshots.`);
  } finally {
    try {
      await stop(server, "SIGTERM");
      if (pool && fixturesAllowed) {
        await pool.query(`DROP TRIGGER IF EXISTS ${fixtureName} ON lastresort.reservations`);
        await pool.query(`DROP TRIGGER IF EXISTS ${fixtureName} ON lastresort.booking_operations`);
        await pool.query(`DROP FUNCTION IF EXISTS lastresort.${fixtureName}()`);
        await pool.query(`DROP SEQUENCE IF EXISTS lastresort.${fixtureName}`);
        await pool.query("DELETE FROM lastresort.booking_operations WHERE event_id=ANY($1::text[])", [eventIds]);
        await pool.query("DELETE FROM lastresort.reservations WHERE event_id=ANY($1::text[])", [eventIds]);
        await pool.query("DELETE FROM lastresort.events WHERE id=ANY($1::text[])", [eventIds]);
        await pool.query("DELETE FROM lastresort.guest_sessions WHERE token_hash=ANY($1::text[])", [tokenHashes]);
      }
      report.cleanupCompleted = true;
    } catch { report.status = "failed"; report.cleanupCompleted = false; }
    finally {
      if (pool) await pool.end().catch(() => { report.status = "failed"; report.cleanupCompleted = false; });
    }
    report.finishedAt = new Date().toISOString();
    await writeJson(reportPath, report);
    console.log(`Failure recovery evidence: ${relative(process.cwd(), reportPath)}`);
  }
  if (report.status !== "passed") process.exitCode = 1;
}

main().catch(() => {
  console.error("Failure recovery runner could not complete or retain evidence. No connection details were logged.");
  process.exitCode = 1;
});
