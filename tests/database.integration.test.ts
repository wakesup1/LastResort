import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Pool, type QueryResultRow } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableDatabase } from "../src/server/config.ts";
import { checkHealth } from "../src/server/health.ts";
import { createGuestSession, GUEST_SESSION_COOKIE_NAME, resolveGuestSession } from "../src/server/guest-session.ts";
import { readReservation, reserveTicket } from "../src/server/reservations.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("Missing configuration: TEST_DATABASE_URL (dedicated lastresort_test database required)");
const testConfig = { appEnv: "test" as const, databaseUrl, appOrigin: null };
const pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 3000 });

function command(action: string, appEnv = "test", ...args: string[]) {
  return execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/database.ts", action, ...args], {
    env: { ...process.env, APP_ENV: appEnv, DATABASE_URL: databaseUrl },
    encoding: "utf8", stdio: "pipe", timeout: 15000,
  });
}

beforeAll(async () => {
  const result = await pool.query("SELECT current_database() AS name");
  assertDisposableDatabase(testConfig, result.rows[0].name);
  command("migrate");
  const marker = await pool.query("SELECT name FROM lastresort.environment WHERE id=1");
  if (!marker.rows[0]) throw new Error("Missing database environment marker");
  assertDisposableDatabase(testConfig, result.rows[0].name, marker.rows[0].name);
});
afterAll(async () => { await pool.end(); });

describe("PostgreSQL foundation commands", () => {
  it("migrates repeatedly and seeds exactly one complete event", async () => {
    command("reset", "test", "--confirm-reset");
    command("migrate");
    command("seed");
    command("seed");
    const events = await pool.query("SELECT * FROM lastresort.events");
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]).toMatchObject({ id: "live-sessions-demo", capacity: 100, remaining: 100, price_minor: 0, venue: "Demo Hall", ticket_type: "General admission" });
    expect((await pool.query("SELECT * FROM lastresort.migrations")).rows).toHaveLength(4);
    expect(await checkHealth((sql) => pool.query(sql))).toMatchObject({ status: 200 });
  });
  it("seed does not replenish inventory", async () => {
    await pool.query("UPDATE lastresort.events SET remaining=99");
    command("seed");
    expect((await pool.query("SELECT remaining FROM lastresort.events")).rows[0].remaining).toBe(99);
  });
  it("refuses an unconfirmed reset without changing data", async () => {
    expect(() => command("reset")).toThrow();
    expect((await pool.query("SELECT remaining FROM lastresort.events")).rows[0].remaining).toBe(99);
  });
  it("refuses a production environment without changing data", async () => {
    expect(() => command("reset", "production", "--confirm-reset")).toThrow();
    expect((await pool.query("SELECT remaining FROM lastresort.events")).rows[0].remaining).toBe(99);
  });
  it("refuses a production database marker even when APP_ENV says test", async () => {
    await pool.query("UPDATE lastresort.environment SET name='production' WHERE id=1");
    try {
      expect(() => command("reset", "test", "--confirm-reset")).toThrow();
      expect((await pool.query("SELECT remaining FROM lastresort.events")).rows[0].remaining).toBe(99);
    } finally {
      await pool.query("UPDATE lastresort.environment SET name='test' WHERE id=1");
    }
  });
  it("resets confirmed test data and preserves other schemas", async () => {
    await pool.query("CREATE TABLE IF NOT EXISTS public.foundation_sentinel (id int PRIMARY KEY)");
    await pool.query("INSERT INTO public.foundation_sentinel VALUES (1) ON CONFLICT DO NOTHING");
    const guest = await createGuestSession((sql, values) => pool.query(sql, values));
    await pool.query(
      `INSERT INTO lastresort.reservations (reference, guest_session_id, event_id, quantity, status)
       VALUES ($1, $2, 'live-sessions-demo', 1, 'confirmed')`, [randomUUID(), guest.session.ownerId],
    );
    command("reset", "test", "--confirm-reset");
    expect((await pool.query("SELECT remaining FROM lastresort.events")).rows[0].remaining).toBe(100);
    expect((await pool.query("SELECT id FROM lastresort.guest_sessions")).rows).toHaveLength(0);
    expect((await pool.query("SELECT reference FROM lastresort.reservations")).rows).toHaveLength(0);
    expect((await pool.query("SELECT * FROM public.foundation_sentinel")).rows).toHaveLength(1);
    await pool.query("DROP TABLE public.foundation_sentinel");
  });

  it("persists distinct guest owners, stores token hashes, and rejects expired sessions", async () => {
    const query = (sql: string, values: string[]) => pool.query(sql, values);
    const first = await createGuestSession(query);
    const second = await createGuestSession(query);
    const firstToken = first.setCookie.split(";")[0]?.split("=")[1] ?? "";
    const secondToken = second.setCookie.split(";")[0]?.split("=")[1] ?? "";

    expect(await resolveGuestSession(query, `${GUEST_SESSION_COOKIE_NAME}=${firstToken}`)).toEqual(first.session);
    expect(await resolveGuestSession(query, `${GUEST_SESSION_COOKIE_NAME}=${secondToken}`)).toEqual(second.session);
    expect(first.session.ownerId).not.toBe(second.session.ownerId);
    const hashes = await pool.query("SELECT token_hash FROM lastresort.guest_sessions WHERE id = ANY($1::uuid[])", [[first.session.ownerId, second.session.ownerId]]);
    expect(hashes.rows.map((row: { token_hash: string }) => row.token_hash)).not.toContain(firstToken);
    expect(hashes.rows.map((row: { token_hash: string }) => row.token_hash)).not.toContain(secondToken);

    await pool.query(
      `UPDATE lastresort.guest_sessions
          SET created_at = now() - interval '2 seconds', expires_at = now() - interval '1 second'
        WHERE id = $1`,
      [first.session.ownerId],
    );
    expect(await resolveGuestSession(query, `${GUEST_SESSION_COOKIE_NAME}=${firstToken}`)).toBeNull();
    expect(await resolveGuestSession(query, `${GUEST_SESSION_COOKIE_NAME}=${secondToken}`)).toEqual(second.session);
  });
});

describe("PostgreSQL 17 atomic reservations (S1-11)", () => {
  let eventId: string;
  let cookie: string;
  let ownerId: string;

  beforeEach(async () => {
    eventId = `booking-${randomUUID()}`;
    await pool.query(
      `INSERT INTO lastresort.events
         (id, name, starts_at, venue, ticket_type, price_minor, sale_opens_at, sale_closes_at, capacity, remaining)
       VALUES ($1, 'Atomic booking fixture', clock_timestamp() + interval '2 days', 'Test Hall',
               'General admission', 0, clock_timestamp() - interval '1 day', clock_timestamp() + interval '1 day', 1, 1)`,
      [eventId],
    );
    const guest = await createGuestSession((sql, values) => pool.query(sql, values));
    cookie = guest.setCookie.split(";")[0];
    ownerId = guest.session.ownerId;
  });

  async function book(guestCookie = cookie, id = eventId) {
    const client = await pool.connect();
    try { return await reserveTicket(client, guestCookie, id); }
    finally { client.release(); }
  }

  async function expectInventory(remaining: number, confirmed: number) {
    const result = await pool.query(
      `SELECT remaining, capacity, (SELECT count(*)::int FROM lastresort.reservations WHERE event_id = $1) AS confirmed
         FROM lastresort.events WHERE id = $1`, [eventId],
    );
    expect(result.rows[0]).toMatchObject({ remaining, confirmed });
    expect(result.rows[0].remaining + result.rows[0].confirmed).toBe(result.rows[0].capacity);
  }

  async function waitUntil(check: () => Promise<boolean>) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await check()) return;
      await delay(10);
    }
    throw new Error("Timed out waiting for a database condition.");
  }

  it("commits a one-ticket reference owned only by the validated session", async () => {
    const result = await book();
    expect(result).toMatchObject({ reservation: { quantity: 1, status: "confirmed", event: { eventId } } });
    if (!("reservation" in result)) throw new Error("Expected a confirmed reservation.");
    const stored = await pool.query("SELECT * FROM lastresort.reservations WHERE reference = $1", [result.reservation.reference]);
    expect(stored.rows[0]).toMatchObject({ guest_session_id: ownerId, event_id: eventId, quantity: 1, status: "confirmed" });
    expect(result.reservation.createdAt).toBe(stored.rows[0].created_at.toISOString());
    await expectInventory(0, 1);
  });

  it("reopens the persisted original result and hides it from other/expired sessions without writes", async () => {
    const result = await book();
    if (!("reservation" in result)) throw new Error("Expected a confirmed reservation.");
    const { reference } = result.reservation;
    const other = await createGuestSession((sql, values) => pool.query(sql, values));
    const otherCookie = other.setCookie.split(";")[0];
    const freshConnection = await pool.connect();
    try {
      expect(await readReservation(freshConnection, cookie, reference)).toEqual(result);
      expect(await readReservation(freshConnection, cookie, reference)).toEqual(result);
      expect(await readReservation(freshConnection, otherCookie, reference)).toEqual({ code: "NOT_FOUND" });
      expect(await readReservation(freshConnection, cookie, randomUUID())).toEqual({ code: "NOT_FOUND" });
      expect(await readReservation(freshConnection, "", reference)).toEqual({ code: "SESSION_REQUIRED" });
      await pool.query("UPDATE lastresort.guest_sessions SET created_at = now() - interval '2 seconds', expires_at = now() - interval '1 second' WHERE id = $1", [ownerId]);
      expect(await readReservation(freshConnection, cookie, reference)).toEqual({ code: "SESSION_REQUIRED" });
    } finally { freshConnection.release(); }
    await expectInventory(0, 1);
  });

  it("allows exactly one of two overlapping connections to obtain the last ticket", async () => {
    const blocker = await pool.connect();
    const clients = await Promise.all([pool.connect(), pool.connect()]);
    const pending: ReturnType<typeof reserveTicket>[] = [];
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM lastresort.events WHERE id = $1 FOR UPDATE", [eventId]);
      const contenderPids = await Promise.all(clients.map(async (client) =>
        (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
      ));
      pending.push(...clients.map((client) => reserveTicket(client, cookie, eventId)));
      await waitUntil(async () => {
        const waits = await pool.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE pid = ANY($1::int[]) AND wait_event_type = 'Lock'", [contenderPids]);
        return waits.rows[0].count === 2;
      });
      await blocker.query("COMMIT");
      const results = await Promise.all(pending);
      expect(results.filter((result) => "reservation" in result)).toHaveLength(1);
      expect(results.filter((result) => "code" in result)).toEqual([{ code: "SOLD_OUT" }]);
      await expectInventory(0, 1);
    } finally {
      await blocker.query("ROLLBACK");
      await Promise.allSettled(pending);
      clients.forEach((client) => client.release());
      blocker.release();
    }
  });

  it("rolls back the inventory decrement if the reservation insert fails, then permits a fresh booking", async () => {
    await pool.query(`CREATE FUNCTION lastresort.reject_booking_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Injected reservation storage failure'; END $$`);
    try {
      await pool.query(`CREATE TRIGGER reject_booking_fixture BEFORE INSERT ON lastresort.reservations
                       FOR EACH ROW EXECUTE FUNCTION lastresort.reject_booking_fixture()`);
      await expect(book()).rejects.toThrow();
      await expectInventory(1, 0);
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS reject_booking_fixture ON lastresort.reservations");
      await pool.query("DROP FUNCTION lastresort.reject_booking_fixture()");
    }
    expect(await book()).toHaveProperty("reservation");
    await expectInventory(0, 1);
  });

  it.each(["not_open", "closed"])("rejects %s sales without changing inventory or entitlements", async (state) => {
    if (state === "not_open") {
      await pool.query("UPDATE lastresort.events SET sale_opens_at = clock_timestamp() + interval '1 hour' WHERE id = $1", [eventId]);
    } else {
      await pool.query("UPDATE lastresort.events SET sale_closes_at = clock_timestamp() - interval '1 hour' WHERE id = $1", [eventId]);
    }
    expect(await book()).toEqual({ code: state === "not_open" ? "SALES_NOT_OPEN" : "SALES_CLOSED" });
    await expectInventory(1, 0);
  });

  it.each([
    ["2026-10-21T08:59:59.999999Z", "SALES_NOT_OPEN"],
    ["2026-10-21T09:00:00Z", "confirmed"],
    ["2026-10-21T09:00:59.999999Z", "confirmed"],
    ["2026-10-21T09:01:00Z", "SALES_CLOSED"],
  ])("checks inclusive opening and exclusive closing at %s", async (checkedAt, expected) => {
    await pool.query(
      `UPDATE lastresort.events SET sale_opens_at = '2026-10-21T09:00:00Z',
         sale_closes_at = '2026-10-21T09:01:00Z', starts_at = '2026-10-22T09:00:00Z' WHERE id = $1`, [eventId],
    );
    const client = await pool.connect();
    try {
      // Run the application's actual SQL on PostgreSQL with a controlled test-only clock.
      const result = await reserveTicket({
        query: <Row extends QueryResultRow>(sql: string, values?: string[]) =>
          client.query<Row>(sql.replaceAll("clock_timestamp()", `TIMESTAMPTZ '${checkedAt}'`), values),
      }, cookie, eventId);
      if (expected === "confirmed") {
        expect(result).toHaveProperty("reservation");
        await expectInventory(0, 1);
      } else {
        expect(result).toEqual({ code: expected });
        await expectInventory(1, 0);
      }
    } finally {
      client.release();
    }
  });

  it("uses the current database time after waiting for an inventory lock", async () => {
    const blocker = await pool.connect();
    const client = await pool.connect();
    let pending: ReturnType<typeof reserveTicket> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("UPDATE lastresort.events SET sale_closes_at = clock_timestamp() + interval '500 milliseconds' WHERE id = $1", [eventId]);
      const pid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      pending = reserveTicket(client, cookie, eventId);
      await waitUntil(async () => (await pool.query("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))) AS waiting", [pid])).rows[0].waiting);
      await waitUntil(async () => (await blocker.query("SELECT clock_timestamp() >= sale_closes_at AS closed FROM lastresort.events WHERE id = $1", [eventId])).rows[0].closed);
      await blocker.query("COMMIT");
      expect(await pending).toEqual({ code: "SALES_CLOSED" });
      await expectInventory(1, 0);
    } finally {
      await blocker.query("ROLLBACK");
      if (pending) await Promise.allSettled([pending]);
      blocker.release();
      client.release();
    }
  });

  it("rejects missing/forged/expired sessions and unknown events without entitlements", async () => {
    expect(await book("")).toEqual({ code: "SESSION_REQUIRED" });
    expect(await book("lastresort_guest=forged")).toEqual({ code: "SESSION_REQUIRED" });
    expect(await book(`lastresort_guest=${"B".repeat(43)}`)).toEqual({ code: "SESSION_REQUIRED" });
    expect(await book(cookie, "missing-event")).toEqual({ code: "NOT_FOUND" });
    await pool.query("UPDATE lastresort.guest_sessions SET created_at = now() - interval '2 seconds', expires_at = now() - interval '1 second' WHERE id = $1", [ownerId]);
    expect(await book()).toEqual({ code: "SESSION_REQUIRED" });
    await expectInventory(1, 0);
  });

  it("enforces reservation constraints and inventory bounds in PostgreSQL", async () => {
    for (const [quantity, status, owner] of [[2, "confirmed", ownerId], [1, "pending", ownerId], [1, "confirmed", randomUUID()]]) {
      await expect(pool.query("INSERT INTO lastresort.reservations (reference, guest_session_id, event_id, quantity, status) VALUES ($1, $2, $3, $4, $5)", [randomUUID(), owner, eventId, quantity, status])).rejects.toThrow();
    }
    await expect(pool.query("UPDATE lastresort.events SET remaining = -1 WHERE id = $1", [eventId])).rejects.toThrow();
    await expect(pool.query("UPDATE lastresort.events SET remaining = capacity + 1 WHERE id = $1", [eventId])).rejects.toThrow();
    await expectInventory(1, 0);
  });
});
