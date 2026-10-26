import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Pool } from "pg";
import { isReservation } from "../src/app/_lib/booking.ts";

export async function verifyIdempotencyHttp(origin: string, pool: Pool, ownerCookie: string, otherCookie: string) {
  const eventIds = [`http-duplicates-${randomUUID()}`, `http-conflict-${randomUUID()}`];
  const [eventId, alternateId] = eventIds;
  const key = randomUUID();
  async function post(event: string, operationKey: string = key, cookie = ownerCookie, body = JSON.stringify({ eventId: event, quantity: 1 })) {
    const response = await fetch(`${origin}/api/reservations`, {
      method: "POST", headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json", "Idempotency-Key": operationKey },
      body, signal: AbortSignal.timeout(10000),
    });
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.has("set-cookie"), false);
    return response;
  }
  async function expectError(response: Response, status: number, code: string) {
    assert.equal(response.status, status);
    const body: unknown = await response.json();
    assert.ok(typeof body === "object" && body !== null && "error" in body && typeof body.error === "object" && body.error !== null && "code" in body.error);
    assert.equal(body.error.code, code);
  }
  try {
    for (const [index, id] of eventIds.entries()) {
      await pool.query(
        `INSERT INTO lastresort.events
         (id, name, starts_at, venue, ticket_type, price_minor, sale_opens_at, sale_closes_at, capacity, remaining)
         VALUES ($1, 'HTTP idempotency fixture', clock_timestamp()+interval '2 days', 'Test Hall', 'General admission',
                 0, clock_timestamp()-interval '1 day', clock_timestamp()+interval '1 day', $2, $2)`, [id, index === 0 ? 4 : 2],
      );
    }
    // Invalid input must not claim the key; the same key remains available for a valid request.
    await expectError(await post(eventId, key, ownerCookie, JSON.stringify({ eventId, quantity: 2 })), 400, "INVALID_REQUEST");
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM lastresort.booking_operations WHERE operation_key=$1", [key])).rows[0].count, 0);

    const gate = await pool.connect();
    let settled: Promise<PromiseSettledResult<Response>[]> | undefined;
    let responses: Response[] = [];
    try {
      await gate.query("BEGIN");
      await gate.query("SELECT id FROM lastresort.events WHERE id=$1 FOR UPDATE", [eventId]);
      settled = Promise.allSettled(Array.from({ length: 8 }, (_, index) => post(
        eventId, index % 2 ? key.toUpperCase() : key, ownerCookie,
        index % 2 ? ` { "quantity": 1, "eventId": "${eventId}" } ` : JSON.stringify({ eventId, quantity: 1 }),
      )));
      // Eight HTTP submissions share the application's pool; prove at least two overlap in PostgreSQL.
      const deadline = Date.now() + 3000;
      let overlapping = false;
      while (Date.now() < deadline) {
        const waits = await pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND application_name='lastresort' AND wait_event_type='Lock'",
        );
        if (waits.rows[0].count >= 2) { overlapping = true; break; }
        await delay(10);
      }
      assert.ok(overlapping, "Expected at least two real HTTP booking transactions to overlap.");
      await gate.query("COMMIT");
      responses = (await settled).map((result) => {
        if (result.status === "rejected") throw result.reason;
        return result.value;
      });
    } finally {
      try {
        try { await gate.query("ROLLBACK"); }
        finally { if (settled) await settled; }
      } finally { gate.release(); }
    }
    assert.equal(responses.filter((response) => response.status === 201).length, 1);
    assert.equal(responses.filter((response) => response.status === 200).length, 7);
    const payloads: unknown[] = await Promise.all(responses.map((response) => response.json()));
    const original = payloads[0];
    assert.ok(isReservation(original));
    for (const payload of payloads) assert.deepEqual(payload, original);
    const persisted = await pool.query("SELECT event_id, quantity, response FROM lastresort.booking_operations WHERE operation_key=$1", [key]);
    assert.deepEqual(persisted.rows, [{ event_id: eventId, quantity: 1, response: { reservation: original } }]);
    assert.equal((await pool.query("SELECT remaining FROM lastresort.events WHERE id=$1", [eventId])).rows[0].remaining, 3);

    await expectError(await post(alternateId), 409, "OPERATION_CONFLICT");
    for (const quantity of [0, -1, 2, 1.5, "1", null]) {
      await expectError(await post(eventId, key, ownerCookie, JSON.stringify({ eventId, quantity })), 400, "INVALID_REQUEST");
    }
    assert.deepEqual((await pool.query("SELECT event_id, quantity, response FROM lastresort.booking_operations WHERE operation_key=$1", [key])).rows, persisted.rows);
    const replay = await post(eventId);
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), original);
    assert.equal((await pool.query("SELECT remaining FROM lastresort.events WHERE id=$1", [alternateId])).rows[0].remaining, 2);

    // A different owner can use that key for another valid payload, but cannot read the first result.
    const independent = await post(alternateId, key, otherCookie);
    assert.equal(independent.status, 201);
    const otherBooking: unknown = await independent.json();
    assert.ok(isReservation(otherBooking));
    assert.equal(otherBooking.event.eventId, alternateId);
    assert.notEqual(otherBooking.reference, original.reference);
    for (const [reference, cookie] of [[original.reference, otherCookie], [otherBooking.reference, ownerCookie]]) {
      const forbidden = await fetch(`${origin}/api/reservations/${reference}`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(5000) });
      assert.equal(forbidden.headers.get("cache-control"), "no-store");
      await expectError(forbidden, 404, "NOT_FOUND");
    }
    const ownReplay = await post(alternateId, key, otherCookie);
    assert.equal(ownReplay.status, 200);
    assert.deepEqual(await ownReplay.json(), otherBooking);
    const firstReplay = await post(eventId);
    assert.equal(firstReplay.status, 200);
    assert.deepEqual(await firstReplay.json(), original);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM lastresort.booking_operations WHERE operation_key=$1", [key])).rows[0].count, 2);

    const deliberate = await post(eventId, randomUUID());
    assert.equal(deliberate.status, 201);
    const nextBooking: unknown = await deliberate.json();
    assert.ok(isReservation(nextBooking));
    assert.equal(new Set([original.reference, otherBooking.reference, nextBooking.reference]).size, 3);
    const inventory = await pool.query<{ id: string; capacity: number; remaining: number; confirmed: number }>(
      `SELECT id, capacity, remaining, (SELECT count(*)::int FROM lastresort.reservations WHERE event_id=event.id) AS confirmed
       FROM lastresort.events AS event WHERE id=ANY($1::text[])`, [eventIds],
    );
    assert.equal(inventory.rows.length, 2);
    for (const row of inventory.rows) {
      assert.equal(row.remaining + row.confirmed, row.capacity);
      assert.equal(row.remaining, row.id === eventId ? 2 : 1);
      assert.equal(row.confirmed, row.id === eventId ? 2 : 1);
    }
    process.stdout.write("S2-04 HTTP checks passed: 8 duplicate submissions (1 created, 7 replays), payload/quantity rejection, owner isolation and deliberate new operation.\n");
  } finally {
    await pool.query("DELETE FROM lastresort.booking_operations WHERE event_id=ANY($1::text[])", [eventIds]);
    await pool.query("DELETE FROM lastresort.reservations WHERE event_id=ANY($1::text[])", [eventIds]);
    await pool.query("DELETE FROM lastresort.events WHERE id=ANY($1::text[])", [eventIds]);
  }
}
