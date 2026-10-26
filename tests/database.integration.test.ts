import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableDatabase } from "../src/server/config.ts";
import { checkHealth } from "../src/server/health.ts";
import { createCaseEvidence, saveCaseEvidence, type CaseEvidence, type InventorySnapshot } from "../scripts/concurrency-evidence.ts";
import { createGuestSession, GUEST_SESSION_COOKIE_NAME, resolveGuestSession } from "../src/server/guest-session.ts";
import { readBookingOperation, readReservation, readReservationHistory, reserveTicket } from "../src/server/reservations.ts";

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
  it("reports unavailable when booking schema is missing even if events are readable (S2-07)", async () => {
    await pool.query("ALTER TABLE lastresort.booking_operations RENAME TO booking_operations_unavailable_fixture");
    try {
      expect(await checkHealth((sql) => pool.query(sql))).toMatchObject({ status: 503 });
    } finally {
      await pool.query("ALTER TABLE lastresort.booking_operations_unavailable_fixture RENAME TO booking_operations");
    }
    expect(await checkHealth((sql) => pool.query(sql))).toMatchObject({ status: 200 });
  });
  it("migrates repeatedly and seeds exactly one complete event", async () => {
    command("reset", "test", "--confirm-reset");
    command("migrate");
    command("seed");
    command("seed");
    const events = await pool.query("SELECT * FROM lastresort.events");
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]).toMatchObject({ id: "live-sessions-demo", capacity: 100, remaining: 100, price_minor: 0, venue: "Demo Hall", ticket_type: "General admission" });
    expect((await pool.query("SELECT * FROM lastresort.migrations")).rows).toHaveLength(5);
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
    await pool.query(
      `INSERT INTO lastresort.booking_operations (guest_session_id, operation_key, event_id, quantity, response)
       VALUES ($1, $2, 'live-sessions-demo', 1, '{"code":"SOLD_OUT"}')`, [guest.session.ownerId, randomUUID()],
    );
    command("reset", "test", "--confirm-reset");
    expect((await pool.query("SELECT remaining FROM lastresort.events")).rows[0].remaining).toBe(100);
    expect((await pool.query("SELECT id FROM lastresort.guest_sessions")).rows).toHaveLength(0);
    expect((await pool.query("SELECT reference FROM lastresort.reservations")).rows).toHaveLength(0);
    expect((await pool.query("SELECT operation_key FROM lastresort.booking_operations")).rows).toHaveLength(0);
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

describe("PostgreSQL 17 atomic reservations", () => {
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

  it("lists several operations once, isolates other owners and rejects expired sessions (S2-05)", async () => {
    await pool.query("UPDATE lastresort.events SET capacity=4, remaining=4 WHERE id=$1", [eventId]);
    const client = await pool.connect();
    try {
      const key = randomUUID();
      const first = await reserveTicket(client, cookie, eventId, key);
      expect(await reserveTicket(client, cookie, eventId, key)).toMatchObject({ ...first, replayed: true });
      const second = await reserveTicket(client, cookie, eventId, randomUUID());
      const other = await createGuestSession((sql, values) => pool.query(sql, values));
      const otherCookie = other.setCookie.split(";")[0];
      expect(await readReservationHistory(pool, otherCookie, null)).toEqual({ reservations: [], nextCursor: null });
      const otherBooking = await reserveTicket(client, otherCookie, eventId, randomUUID());
      const history = await readReservationHistory(pool, cookie, null);
      if (!("reservations" in history) || !("reservation" in first) || !("reservation" in second) || !("reservation" in otherBooking)) throw new Error("Expected confirmed fixture");
      expect(history.reservations).toEqual([second.reservation, first.reservation]);
      expect(history.nextCursor).toBeNull();
      for (const item of history.reservations) expect(await readReservation(pool, cookie, item.reference)).toEqual({ reservation: item });
      expect(await readReservationHistory(pool, cookie, otherBooking.reservation.reference)).toEqual({ code: "NOT_FOUND" });
      expect(await readReservationHistory(pool, cookie, randomUUID())).toEqual({ code: "NOT_FOUND" });
      expect(await readReservationHistory(pool, null, null)).toEqual({ code: "SESSION_REQUIRED" });
      expect((await pool.query("SELECT remaining FROM lastresort.events WHERE id=$1", [eventId])).rows[0].remaining).toBe(1);
      expect((await pool.query("SELECT count(*)::int AS count FROM lastresort.reservations WHERE event_id=$1", [eventId])).rows[0].count).toBe(3);
      await pool.query("UPDATE lastresort.guest_sessions SET created_at=now()-interval '2 seconds', expires_at=now()-interval '1 second' WHERE id=$1", [ownerId]);
      expect(await readReservationHistory(pool, cookie, null)).toEqual({ code: "SESSION_REQUIRED" });
    } finally { client.release(); }
  }, 15_000);

  it("pages tied and sub-millisecond timestamps without duplicates or omissions (S2-05)", async () => {
    // Construct a consistent persisted fixture, including timestamps JS Date cannot distinguish.
    await pool.query("UPDATE lastresort.events SET capacity=45, remaining=0 WHERE id=$1", [eventId]);
    await pool.query(
      `INSERT INTO lastresort.reservations (reference, guest_session_id, event_id, quantity, status, created_at)
       SELECT gen_random_uuid(), $1, $2, 1, 'confirmed',
              '2026-10-21 09:00:00+00'::timestamptz + (n / 3) * interval '1 microsecond'
         FROM generate_series(1, 45) AS n`, [ownerId, eventId],
    );
    const expected = await pool.query("SELECT reference FROM lastresort.reservations WHERE guest_session_id=$1 ORDER BY created_at DESC, reference ASC", [ownerId]);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 3; page += 1) {
      const result = await readReservationHistory(pool, cookie, cursor);
      if (!("reservations" in result)) throw new Error("Expected owned history");
      expect(result.reservations).toHaveLength(page < 2 ? 20 : 5);
      seen.push(...result.reservations.map((item) => item.reference));
      cursor = result.nextCursor;
      expect(cursor === null).toBe(page === 2);
    }
    expect(seen).toEqual(expected.rows.map((row: { reference: string }) => row.reference));
    expect(new Set(seen).size).toBe(45);
  });

  async function book(guestCookie = cookie, id = eventId, key: string = randomUUID()) {
    const client = await pool.connect();
    try { return await reserveTicket(client, guestCookie, id, key); }
    finally { client.release(); }
  }

  it("recovers a committed operation on a separate connection after response loss, even after sale closure (S2-06)", async () => {
    const key = randomUUID();
    const original = await book(cookie, eventId, key);
    if (!("reservation" in original)) throw new Error("Expected confirmed fixture");
    await pool.query("UPDATE lastresort.events SET name='Changed after booking', sale_closes_at=clock_timestamp() - interval '1 second' WHERE id=$1", [eventId]);
    const reader = await pool.connect();
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect(await readBookingOperation(reader, cookie, key)).toEqual({ eventId, outcome: original });
      }
      const other = await createGuestSession((sql, values) => pool.query(sql, values));
      expect(await readBookingOperation(reader, other.setCookie.split(";")[0], key)).toEqual({ code: "NOT_FOUND" });
      expect(await readBookingOperation(reader, cookie, randomUUID())).toEqual({ code: "NOT_FOUND" });
      expect(await readBookingOperation(reader, null, key)).toEqual({ code: "SESSION_REQUIRED" });
      expect(await readReservationHistory(reader, cookie, null)).toMatchObject({ reservations: [{ reference: original.reservation.reference }] });
      await expectInventory(0, 1);
      expect((await pool.query("SELECT count(*)::int AS count FROM lastresort.booking_operations WHERE event_id=$1", [eventId])).rows[0].count).toBe(1);
      await pool.query("UPDATE lastresort.guest_sessions SET created_at=now()-interval '2 seconds', expires_at=now()-interval '1 second' WHERE id=$1", [ownerId]);
      expect(await readBookingOperation(reader, cookie, key)).toEqual({ code: "SESSION_REQUIRED" });
    } finally { reader.release(); }
  });

  it("does not mistake an uncommitted or rolled-back operation for a known failure (S2-06)", async () => {
    const writer = await pool.connect();
    const key = randomUUID();
    try {
      await writer.query("BEGIN");
      await writer.query(
        "INSERT INTO lastresort.booking_operations (guest_session_id, operation_key, event_id, quantity, response) VALUES ($1, $2, $3, 1, $4::jsonb)",
        [ownerId, key, eventId, JSON.stringify({ code: "SOLD_OUT" })],
      );
      expect(await readBookingOperation(pool, cookie, key)).toEqual({ code: "NOT_FOUND" });
      await writer.query("ROLLBACK");
      expect(await readBookingOperation(pool, cookie, key)).toEqual({ code: "NOT_FOUND" });
      await expectInventory(1, 0);
    } finally { await writer.query("ROLLBACK"); writer.release(); }
  });

  it.each(["NOT_FOUND", "SALES_NOT_OPEN", "SALES_CLOSED", "SOLD_OUT"])("recovers the persisted %s rejection without writing (S2-06)", async (code) => {
    const key = randomUUID();
    if (code === "SALES_NOT_OPEN") await pool.query("UPDATE lastresort.events SET sale_opens_at=clock_timestamp()+interval '1 hour' WHERE id=$1", [eventId]);
    if (code === "SALES_CLOSED") await pool.query("UPDATE lastresort.events SET sale_closes_at=clock_timestamp()-interval '1 second' WHERE id=$1", [eventId]);
    if (code === "SOLD_OUT") await book();
    const target = code === "NOT_FOUND" ? "missing-event" : eventId;
    expect(await book(cookie, target, key)).toEqual({ code });
    const before = await pool.query("SELECT remaining FROM lastresort.events WHERE id=$1", [eventId]);
    expect(await readBookingOperation(pool, cookie, key)).toEqual({ eventId: target, outcome: { code } });
    expect(await pool.query("SELECT remaining FROM lastresort.events WHERE id=$1", [eventId])).toMatchObject({ rows: before.rows });
  });

  async function expectInventory(remaining: number, confirmed: number, evidence?: CaseEvidence) {
    const result = await pool.query<InventorySnapshot>(
      `SELECT remaining, capacity, (SELECT count(*)::int FROM lastresort.reservations WHERE event_id = $1) AS confirmed
         FROM lastresort.events WHERE id = $1`, [eventId],
    );
    if (evidence) evidence.finalState = result.rows[0] ?? null;
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
    const evidence = createCaseEvidence("last-ticket");
    const clients: PoolClient[] = [];
    let blocker: PoolClient | undefined;
    let settled: Promise<PromiseSettledResult<Awaited<ReturnType<typeof reserveTicket>>>[]> | undefined;
    let verified = false;
    try {
      const other = await createGuestSession((sql, values) => pool.query(sql, values));
      const cookies = [cookie, other.setCookie.split(";")[0]];
      const owners = [ownerId, other.session.ownerId];
      blocker = await pool.connect();
      const connections = await Promise.allSettled([pool.connect(), pool.connect()]);
      for (const connection of connections) {
        if (connection.status === "fulfilled") clients.push(connection.value);
      }
      const failed = connections.find((connection) => connection.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM lastresort.events WHERE id = $1 FOR UPDATE", [eventId]);
      const contenderPids = await Promise.all(clients.map(async (client) =>
        (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid,
      ));
      expect(new Set(contenderPids).size).toBe(2);
      settled = Promise.allSettled(clients.map((client, index) => reserveTicket(client, cookies[index], eventId, randomUUID())));
      evidence.phase = "contending";
      await waitUntil(async () => {
        const waits = await pool.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE pid = ANY($1::int[]) AND wait_event_type = 'Lock'", [contenderPids]);
        evidence.observedContenders = waits.rows[0].count;
        return waits.rows[0].count === 2;
      });
      await blocker.query("COMMIT");
      evidence.phase = "booking";
      const outcomes = await settled;
      evidence.failedWorkers = outcomes.filter((result) => result.status === "rejected").length;
      const results = outcomes.map((result) => {
        if (result.status === "rejected") throw result.reason;
        return result.value;
      });
      evidence.outcomes = {
        confirmed: results.filter((result) => "reservation" in result).length,
        soldOut: results.filter((result) => "code" in result && result.code === "SOLD_OUT").length,
        other: results.filter((result) => "code" in result && result.code !== "SOLD_OUT").length,
      };
      evidence.phase = "verification";
      expect(results.filter((result) => "reservation" in result)).toHaveLength(1);
      expect(results.filter((result) => "code" in result)).toEqual([{ code: "SOLD_OUT" }]);
      const winner = results.findIndex((result) => "reservation" in result);
      const winningResult = results[winner];
      if (!("reservation" in winningResult)) throw new Error("Expected one confirmed reservation.");
      const stored = await pool.query(
        "SELECT reference, guest_session_id FROM lastresort.reservations WHERE event_id = $1", [eventId],
      );
      evidence.storedReservations = stored.rows.length;
      expect(stored.rows).toEqual([{ reference: winningResult.reservation.reference, guest_session_id: owners[winner] }]);
      evidence.ownershipVerified = true;
      await expectInventory(0, 1, evidence);
      verified = true;
    } finally {
      try {
        try {
          try { if (blocker) await blocker.query("ROLLBACK"); }
          finally { if (settled) await settled; }
        } finally {
          clients.forEach((client) => client.release());
          blocker?.release();
        }
        evidence.cleanupCompleted = true;
      } finally {
        if (verified && evidence.cleanupCompleted) { evidence.status = "passed"; evidence.phase = "complete"; }
        await saveCaseEvidence(evidence);
      }
    }
  });

  it("keeps capacity 100 consistent across 200 distinct operations on 20 connections (S2-01)", async () => {
    const operationCount = 200;
    const concurrency = 20;
    const evidence = createCaseEvidence("capacity-100");
    // Separate worker connections and an independent observer; no application mutex or mocked SQL.
    const workers = new Pool({ connectionString: databaseUrl, max: concurrency, connectionTimeoutMillis: 5000 });
    let blocker: PoolClient | undefined;
    type OperationResult = { ownerId: string; result: Awaited<ReturnType<typeof reserveTicket>> };
    const clients: PoolClient[] = [];
    const pending: Promise<OperationResult[]>[] = [];
    let settled: Promise<PromiseSettledResult<OperationResult[]>[]> | undefined;
    let observations = 0;
    let verified = false;
    try {
      await pool.query("UPDATE lastresort.events SET capacity = 100, remaining = 100 WHERE id = $1", [eventId]);
      const guests = await Promise.all(Array.from({ length: operationCount }, () =>
        createGuestSession((sql, values) => pool.query(sql, values)),
      ));
      expect(new Set(guests.map((guest) => guest.session.ownerId)).size).toBe(operationCount);
      blocker = await pool.connect();
      const connections = await Promise.allSettled(Array.from({ length: concurrency }, () => workers.connect()));
      for (const connection of connections) {
        if (connection.status === "fulfilled") clients.push(connection.value);
      }
      const failedConnection = connections.find((connection) => connection.status === "rejected");
      if (failedConnection?.status === "rejected") throw failedConnection.reason;
      const pids = await Promise.all(clients.map(async (client) =>
        (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid,
      ));
      expect(new Set(pids).size).toBe(concurrency);
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM lastresort.events WHERE id = $1 FOR UPDATE", [eventId]);
      await expectInventory(100, 0);

      pending.push(...clients.map(async (client, worker) => {
        const results: OperationResult[] = [];
        for (let operation = worker; operation < operationCount; operation += concurrency) {
          const guest = guests[operation];
          const result = await reserveTicket(client, guest.setCookie.split(";")[0], eventId, randomUUID());
          results.push({ ownerId: guest.session.ownerId, result });
          if ("reservation" in result) evidence.outcomes.confirmed += 1;
          else if (result.code === "SOLD_OUT") evidence.outcomes.soldOut += 1;
          else evidence.outcomes.other += 1;
          // Both quantities come from one committed MVCC snapshot, even while other workers write.
          const snapshot = await pool.query<InventorySnapshot>(
            `SELECT remaining, capacity,
                    (SELECT count(*)::int FROM lastresort.reservations WHERE event_id = $1) AS confirmed
               FROM lastresort.events WHERE id = $1`, [eventId],
          );
          const state = snapshot.rows[0];
          evidence.observations.push({ operation, ...state });
          expect(state.remaining).toBeGreaterThanOrEqual(0);
          expect(state.remaining).toBeLessThanOrEqual(state.capacity);
          expect(state.confirmed).toBeLessThanOrEqual(state.capacity);
          expect(state.remaining + state.confirmed).toBe(state.capacity);
          observations += 1;
        }
        return results;
      }));
      // Attach rejection handlers before checking the gate so failures cannot become unhandled rejections.
      settled = Promise.allSettled(pending);
      evidence.phase = "contending";
      await waitUntil(async () => {
        const waits = await pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM pg_stat_activity WHERE pid = ANY($1::int[]) AND wait_event_type = 'Lock'", [pids],
        );
        evidence.observedContenders = waits.rows[0].count;
        return waits.rows[0].count === concurrency;
      });
      await blocker.query("COMMIT");
      evidence.phase = "booking";

      const outcomes = await settled;
      evidence.failedWorkers = outcomes.filter((result) => result.status === "rejected").length;
      const results = outcomes.flatMap((outcome) => {
        if (outcome.status === "rejected") throw outcome.reason;
        return outcome.value;
      });
      evidence.phase = "verification";
      expect(results).toHaveLength(operationCount);
      expect(observations).toBe(operationCount);
      const confirmed = results.flatMap(({ ownerId: guestOwner, result }) =>
        "reservation" in result ? [{ ...result.reservation, ownerId: guestOwner }] : [],
      );
      expect(confirmed).toHaveLength(100);
      expect(new Set(confirmed.map((reservation) => reservation.reference)).size).toBe(100);
      expect(results.flatMap(({ result }) => "code" in result ? [result.code] : [])).toEqual(Array(100).fill("SOLD_OUT"));

      const stored = await pool.query<{ reference: string; guest_session_id: string; quantity: number; status: string }>(
        "SELECT reference, guest_session_id, quantity, status FROM lastresort.reservations WHERE event_id = $1 ORDER BY reference", [eventId],
      );
      evidence.storedReservations = stored.rows.length;
      expect(stored.rows).toEqual(confirmed.map((reservation) => ({
        reference: reservation.reference, guest_session_id: reservation.ownerId, quantity: 1, status: "confirmed",
      })).sort((first, second) => first.reference.localeCompare(second.reference)));
      evidence.ownershipVerified = true;
      await expectInventory(0, 100, evidence);
      verified = true;
    } finally {
      try {
        try {
          // Release the gate before draining workers, including when a contention assertion fails.
          try { if (blocker) await blocker.query("ROLLBACK"); }
          finally { if (settled) await settled; }
        } finally {
          clients.forEach((client) => client.release());
          blocker?.release();
          await workers.end();
        }
        evidence.cleanupCompleted = true;
      } finally {
        if (verified && evidence.cleanupCompleted) { evidence.status = "passed"; evidence.phase = "complete"; }
        await saveCaseEvidence(evidence);
      }
    }
  }, 60_000);

  it("replays the exact persisted result before current sale and event details (S2-03)", async () => {
    const key = randomUUID();
    const first = await book(cookie, eventId, key);
    expect(first).toHaveProperty("reservation");
    await pool.query("UPDATE lastresort.events SET name = 'Changed later', sale_closes_at = clock_timestamp() - interval '1 second' WHERE id = $1", [eventId]);
    expect(await book(cookie, eventId, key.toUpperCase())).toEqual({ ...first, replayed: true });
    await expectInventory(0, 1);
    expect((await pool.query("SELECT response FROM lastresort.booking_operations WHERE guest_session_id = $1 AND operation_key = $2", [ownerId, key])).rows).toEqual([{ response: first }]);
  });

  it("serializes concurrent retries to the same committed reference (S2-03)", async () => {
    const key = randomUUID();
    const blocker = await pool.connect();
    const clients = await Promise.all([pool.connect(), pool.connect()]);
    let settled: Promise<PromiseSettledResult<Awaited<ReturnType<typeof reserveTicket>>>[]> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM lastresort.events WHERE id = $1 FOR UPDATE", [eventId]);
      const pids = await Promise.all(clients.map(async (client) => (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid));
      settled = Promise.allSettled(clients.map((client) => reserveTicket(client, cookie, eventId, key)));
      await waitUntil(async () => (await pool.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE pid = ANY($1::int[]) AND wait_event_type = 'Lock'", [pids])).rows[0].count === 2);
      await blocker.query("COMMIT");
      const results = (await settled).map((result) => {
        if (result.status === "rejected") throw result.reason;
        return result.value;
      });
      expect(results.every((result) => "reservation" in result)).toBe(true);
      expect(results.filter((result) => result.replayed)).toHaveLength(1);
      expect(results.map((result) => "reservation" in result ? result.reservation.reference : null)[0]).toBe(
        results.map((result) => "reservation" in result ? result.reservation.reference : null)[1],
      );
      expect((await pool.query("SELECT operation_key FROM lastresort.booking_operations WHERE guest_session_id = $1", [ownerId])).rows).toHaveLength(1);
      await expectInventory(0, 1);
    } finally {
      await blocker.query("ROLLBACK");
      if (settled) await settled;
      clients.forEach((client) => client.release());
      blocker.release();
    }
  }, 15_000);

  it("rejects changed payloads and keeps the same key private to each owner (S2-03)", async () => {
    await pool.query("UPDATE lastresort.events SET capacity = 2, remaining = 2 WHERE id = $1", [eventId]);
    const key = randomUUID();
    const first = await book(cookie, eventId, key);
    if (!("reservation" in first)) throw new Error("Expected confirmation.");
    expect(await book(cookie, "different-event", key)).toEqual({ code: "OPERATION_CONFLICT" });
    const other = await createGuestSession((sql, values) => pool.query(sql, values));
    const otherCookie = other.setCookie.split(";")[0];
    const second = await book(otherCookie, eventId, key);
    if (!("reservation" in second)) throw new Error("Expected independent confirmation.");
    expect(second.reservation.reference).not.toBe(first.reservation.reference);
    expect(await readReservation(pool, otherCookie, first.reservation.reference)).toEqual({ code: "NOT_FOUND" });
    expect(await book(cookie, eventId, key)).toEqual({ ...first, replayed: true });
    await expectInventory(0, 2);
  }, 15_000);

  it("keeps a lock-timeout retry on the original operation (S2-03)", async () => {
    const key = randomUUID();
    const original = await book(cookie, eventId, key);
    const blocker = await pool.connect();
    const retry = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT operation_key FROM lastresort.booking_operations WHERE guest_session_id = $1 AND operation_key = $2 FOR UPDATE", [ownerId, key]);
      await retry.query("SET statement_timeout = '150ms'");
      await expect(reserveTicket(retry, cookie, eventId, key)).rejects.toMatchObject({ code: "57014" });
      await blocker.query("COMMIT");
      expect(await book(cookie, eventId, key)).toEqual({ ...original, replayed: true });
      await expectInventory(0, 1);
    } finally {
      await blocker.query("ROLLBACK");
      await retry.query("RESET statement_timeout");
      blocker.release();
      retry.release();
    }
  }, 15_000);

  it.each(["SALES_NOT_OPEN", "SALES_CLOSED", "SOLD_OUT", "NOT_FOUND"])("retains terminal %s even after availability changes (S2-03)", async (code) => {
    const key = randomUUID();
    let target = eventId;
    if (code === "SALES_NOT_OPEN") await pool.query("UPDATE lastresort.events SET sale_opens_at = clock_timestamp() + interval '1 hour' WHERE id = $1", [eventId]);
    if (code === "SALES_CLOSED") await pool.query("UPDATE lastresort.events SET sale_closes_at = clock_timestamp() - interval '1 hour' WHERE id = $1", [eventId]);
    if (code === "SOLD_OUT") expect(await book()).toHaveProperty("reservation");
    if (code === "NOT_FOUND") target = `missing-${randomUUID()}`;
    expect(await book(cookie, target, key)).toEqual({ code });
    if (code === "NOT_FOUND") {
      await pool.query(
        `INSERT INTO lastresort.events SELECT $1, name, starts_at, venue, ticket_type, price_minor,
          sale_opens_at, sale_closes_at, capacity, remaining FROM lastresort.events WHERE id = $2`, [target, eventId],
      );
    } else {
      await pool.query("UPDATE lastresort.events SET sale_opens_at = clock_timestamp() - interval '1 day', sale_closes_at = clock_timestamp() + interval '1 day', capacity = capacity + 1, remaining = remaining + 1 WHERE id = $1", [eventId]);
    }
    const before = await pool.query("SELECT remaining FROM lastresort.events WHERE id = $1", [target]);
    expect(await book(cookie, target, key)).toEqual({ code, replayed: true });
    expect((await pool.query("SELECT remaining FROM lastresort.events WHERE id = $1", [target])).rows).toEqual(before.rows);
    expect((await pool.query("SELECT response FROM lastresort.booking_operations WHERE guest_session_id = $1 AND operation_key = $2", [ownerId, key])).rows).toEqual([{ response: { code } }]);
  }, 15_000);

  it("rolls back the inventory and key if the reservation insert fails, then permits the same key", async () => {
    const key = randomUUID();
    await pool.query(`CREATE FUNCTION lastresort.reject_booking_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Injected reservation storage failure'; END $$`);
    try {
      await pool.query(`CREATE TRIGGER reject_booking_fixture BEFORE INSERT ON lastresort.reservations
                       FOR EACH ROW EXECUTE FUNCTION lastresort.reject_booking_fixture()`);
      await expect(book(cookie, eventId, key)).rejects.toThrow();
      await expectInventory(1, 0);
      expect((await pool.query("SELECT operation_key FROM lastresort.booking_operations WHERE guest_session_id = $1", [ownerId])).rows).toHaveLength(0);
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS reject_booking_fixture ON lastresort.reservations");
      await pool.query("DROP FUNCTION lastresort.reject_booking_fixture()");
    }
    expect(await book(cookie, eventId, key)).toHaveProperty("reservation");
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
      }, cookie, eventId, randomUUID());
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
      pending = reserveTicket(client, cookie, eventId, randomUUID());
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
