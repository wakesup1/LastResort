import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { assertDisposableDatabase, readConfig } from "../src/server/config.ts";
import { BOOKING_STORAGE_KEY, createBookingController } from "../src/app/_lib/booking.ts";

type HttpResult = { status: number; headers: IncomingHttpHeaders; body: string };

async function getAvailablePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not select an HTTP test port.");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}

function postSession(port: number, origin: string, body?: string) {
  return new Promise<HttpResult>((resolve, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port,
      path: "/api/session",
      method: "POST",
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: origin,
        ...(body === undefined
          ? { "Content-Length": "0" }
          : { "Content-Length": String(Buffer.byteLength(body)), "Content-Type": "application/json" }),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.setTimeout(5000, () => request.destroy(new Error("Session HTTP test timed out.")));
    request.on("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

async function waitForServer(child: ChildProcess, port: number) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("The production server exited before becoming ready.");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (response.status === 200 || response.status === 503) return;
    } catch {}
    await delay(200);
  }
  throw new Error("The production server did not become ready.");
}

async function stopServer(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    delay(5000),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("Set TEST_DATABASE_URL to a dedicated disposable PostgreSQL 17 test database.");

const config = readConfig({ APP_ENV: "test", DATABASE_URL: databaseUrl });
const pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 3000 });
let server: ChildProcess | undefined;
let serverOutput = "";
let createdTokenHash: string | undefined;
let otherTokenHash: string | undefined;
const bookingEventId = `http-booking-${randomUUID()}`;
let createdBookingFixture = false;

try {
  const databaseState = await pool.query<{ name: string }>("SELECT current_database() AS name");
  const databaseName = databaseState.rows[0]?.name;
  if (!databaseName) throw new Error("Could not verify the test database name.");
  assertDisposableDatabase(config, databaseName);
  const markerState = await pool.query<{ name: string }>("SELECT name FROM lastresort.environment WHERE id = 1");
  const marker = markerState.rows[0]?.name;
  if (!marker) throw new Error("The test database must be migrated and have an environment marker.");
  assertDisposableDatabase(config, databaseName, marker);

  const port = await getAvailablePort();
  server = spawn(process.execPath, [
    "node_modules/next/dist/bin/next",
    "start",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(port),
  ], {
    env: {
      ...process.env,
      APP_ENV: "test",
      APP_ORIGIN: "",
      DATABASE_URL: databaseUrl,
      NEXT_TELEMETRY_DISABLED: "1",
      NODE_ENV: "production",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", (chunk: Buffer) => { serverOutput += chunk.toString("utf8"); });
  server.stderr?.on("data", (chunk: Buffer) => { serverOutput += chunk.toString("utf8"); });

  await waitForServer(server, port);
  const origin = `http://127.0.0.1:${port}`;
  const accepted = await postSession(port, origin);
  assert.equal(accepted.status, 204, `Expected an empty same-origin POST to succeed; received ${accepted.status}: ${accepted.body}`);
  assert.equal(accepted.body, "");
  const cookie = Array.isArray(accepted.headers["set-cookie"])
    ? accepted.headers["set-cookie"][0]
    : accepted.headers["set-cookie"];
  assert.ok(cookie, "Expected the successful request to set the guest session cookie.");
  const token = cookie.split(";", 1)[0]?.split("=", 2)[1];
  assert.ok(token, "Expected the guest session cookie to contain a token.");
  createdTokenHash = createHash("sha256").update(token, "utf8").digest("hex");

  const rejectedBody = await postSession(port, origin, "{}");
  assert.equal(rejectedBody.status, 400, `Expected a nonempty body to be rejected: ${rejectedBody.body}`);
  assert.match(rejectedBody.body, /INVALID_REQUEST/);

  const rejectedOrigin = await postSession(port, "http://attacker.test");
  assert.equal(rejectedOrigin.status, 403, `Expected a cross-origin request to be rejected: ${rejectedOrigin.body}`);
  assert.match(rejectedOrigin.body, /ORIGIN_FORBIDDEN/);

  await pool.query(
    `INSERT INTO lastresort.events
       (id, name, starts_at, venue, ticket_type, price_minor, sale_opens_at, sale_closes_at, capacity, remaining)
     VALUES ($1, 'HTTP booking fixture', clock_timestamp() + interval '2 days', 'Test Hall', 'General admission',
             0, clock_timestamp() - interval '1 day', clock_timestamp() + interval '1 day', 1, 1)`, [bookingEventId],
  );
  createdBookingFixture = true;
  async function postBooking(headers: Record<string, string> = {}, extraInput: Record<string, unknown> = {}) {
    return fetch(`${origin}/api/reservations`, {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "Idempotency-Key": randomUUID(), Cookie: cookie?.split(";")[0] ?? "", ...headers },
      body: JSON.stringify({ eventId: bookingEventId, quantity: 1, ...extraInput }),
      signal: AbortSignal.timeout(5000),
    });
  }
  for (const [headers, extraInput, expectedStatus] of [
    [{ Cookie: "" }, {}, 401],
    [{ Origin: "http://attacker.test" }, {}, 403],
    [{ "Idempotency-Key": "invalid" }, {}, 400],
    [{ "Idempotency-Key": "" }, {}, 400],
    [{}, { quantity: 2 }, 400],
    [{}, { ownerId: randomUUID() }, 400],
  ] satisfies [Record<string, string>, Record<string, unknown>, number][]) {
    const response = await postBooking(headers, extraInput);
    assert.equal(response.status, expectedStatus);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal((await pool.query("SELECT remaining FROM lastresort.events WHERE id = $1", [bookingEventId])).rows[0].remaining, 1);

  // Lose the first response after the real production server has committed.
  // Recreate the browser controller with its persisted marker, then explicitly read the result.
  const browserValues = new Map<string, string>();
  const browserStorage = {
    getItem: (key: string) => browserValues.get(key) ?? null,
    setItem: (key: string, value: string) => { browserValues.set(key, value); },
    removeItem: (key: string) => { browserValues.delete(key); },
  };
  const captured: { booked?: Response } = {};
  const recoveryRequests: string[] = [];
  const browserSend: typeof fetch = async (url, options) => {
    const path = String(url);
    recoveryRequests.push(`${options?.method ?? "GET"} ${path}`);
    const headers = new Headers(options?.headers);
    headers.set("Origin", origin);
    headers.set("Cookie", cookie.split(";")[0]);
    const response = await fetch(`${origin}${path}`, {
      ...options,
      headers,
    });
    if (path === "/api/reservations" && options?.method === "POST") {
      captured.booked = response;
      throw new TypeError("Simulated response loss after commit");
    }
    return response;
  };
  assert.deepEqual(await createBookingController(browserStorage, browserSend).confirm(bookingEventId), { kind: "unknown" });
  const savedOperation: unknown = JSON.parse(browserStorage.getItem(BOOKING_STORAGE_KEY) ?? "{}");
  assert.ok(typeof savedOperation === "object" && savedOperation !== null && "operationId" in savedOperation && typeof savedOperation.operationId === "string");
  const operationKey = savedOperation.operationId;
  assert.match(operationKey, /^[0-9a-f-]{36}$/);
  const booked = captured.booked;
  assert.ok(booked);
  assert.equal(booked.status, 201);
  assert.equal(booked.headers.get("cache-control"), "no-store");
  const booking: unknown = await booked.json();
  assert.ok(typeof booking === "object" && booking !== null && "reference" in booking && "status" in booking);
  assert.equal(booking.status, "confirmed");
  const stored = await pool.query(
    `SELECT reservation.reference, reservation.quantity FROM lastresort.reservations AS reservation
       JOIN lastresort.guest_sessions AS owner ON owner.id = reservation.guest_session_id
      WHERE reservation.event_id = $1 AND owner.token_hash = $2`, [bookingEventId, createdTokenHash],
  );
  assert.equal(stored.rows.length, 1);
  assert.equal(stored.rows[0].reference, booking.reference);
  assert.equal(stored.rows[0].quantity, 1);
  const reloaded = createBookingController(browserStorage, browserSend);
  assert.deepEqual(reloaded.restore(), { kind: "unknown" });
  assert.equal(recoveryRequests.length, 2, "Reload must not submit or check automatically.");
  assert.deepEqual(await reloaded.check(), { kind: "confirmed", reference: booking.reference });
  assert.deepEqual(recoveryRequests, ["POST /api/session", "POST /api/reservations", `GET /api/booking-operations/${operationKey}`]);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM lastresort.reservations WHERE event_id=$1", [bookingEventId])).rows[0].count, 1);
  assert.equal((await pool.query("SELECT remaining FROM lastresort.events WHERE id=$1", [bookingEventId])).rows[0].remaining, 0);
  // Reordered JSON, whitespace and UUID letter case normalize to the same operation.
  const replayed = await fetch(`${origin}/api/reservations`, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json", Cookie: cookie.split(";")[0], "Idempotency-Key": operationKey.toUpperCase() },
    body: JSON.stringify({ quantity: 1, eventId: bookingEventId }, null, 2), signal: AbortSignal.timeout(5000),
  });
  assert.equal(replayed.status, 200);
  assert.deepEqual(await replayed.json(), booking);
  const conflict = await postBooking({ "Idempotency-Key": operationKey }, { eventId: "different-event" });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, "OPERATION_CONFLICT");
  const resultUrl = `${origin}/api/reservations/${String(booking.reference)}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const reopened: Response = await fetch(resultUrl, { headers: { Cookie: cookie.split(";")[0] } });
    assert.equal(reopened.status, 200);
    assert.equal(reopened.headers.get("cache-control"), "no-store");
    assert.deepEqual(await reopened.json(), booking);
  }
  assert.equal((await fetch(resultUrl)).status, 401);
  const otherSession = await postSession(port, origin);
  const otherCookie = otherSession.headers["set-cookie"]?.[0]?.split(";")[0];
  assert.ok(otherCookie);
  otherTokenHash = createHash("sha256").update(otherCookie.split("=")[1], "utf8").digest("hex");
  const operationUrl = `${origin}/api/booking-operations/${operationKey}`;
  const recovered = await fetch(operationUrl, { headers: { Cookie: cookie.split(";")[0] } });
  assert.equal(recovered.status, 200);
  assert.equal(recovered.headers.get("cache-control"), "no-store");
  assert.equal(recovered.headers.has("set-cookie"), false);
  assert.deepEqual(await recovered.json(), { eventId: bookingEventId, outcome: { reservation: booking } });
  assert.equal((await fetch(operationUrl)).status, 401);
  assert.equal((await fetch(`${operationUrl}?ownerId=forged`)).status, 400);
  const hiddenOperation = await fetch(operationUrl, { headers: { Cookie: otherCookie } });
  const missingOperation = await fetch(`${origin}/api/booking-operations/${randomUUID()}`, { headers: { Cookie: otherCookie } });
  assert.equal(hiddenOperation.status, 404);
  assert.equal(missingOperation.status, 404);
  assert.equal(await hiddenOperation.text(), await missingOperation.text());
  const forbiddenRead = await fetch(resultUrl, { headers: { Cookie: otherCookie } });
  const missingRead = await fetch(`${origin}/api/reservations/${randomUUID()}`, { headers: { Cookie: cookie.split(";")[0] } });
  assert.equal(forbiddenRead.status, 404);
  assert.equal(missingRead.status, 404);
  assert.equal(await forbiddenRead.text(), await missingRead.text());
  const otherOwnerAttempt = await postBooking({ Cookie: otherCookie, "Idempotency-Key": operationKey });
  assert.equal(otherOwnerAttempt.status, 409);
  assert.equal((await otherOwnerAttempt.json()).error.code, "SOLD_OUT");
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM lastresort.reservations WHERE event_id = $1", [bookingEventId])).rows[0].count, 1);
  assert.equal((await postBooking()).status, 409);
  assert.equal((await pool.query("SELECT remaining FROM lastresort.events WHERE id = $1", [bookingEventId])).rows[0].remaining, 0);
  const health = await fetch(`${origin}/api/health`);
  assert.equal(health.status, 200);
  await health.json();
  await delay(100);
  const logs: Record<string, unknown>[] = [];
  for (const line of serverOutput.split("\n")) {
    try {
      const entry: unknown = JSON.parse(line);
      if (typeof entry === "object" && entry !== null && "event" in entry && entry.event === "http_request") logs.push(Object.fromEntries(Object.entries(entry)));
    } catch {}
  }
  function diagnostic(response: Response, outcome: string) {
    const requestId = response.headers.get("x-request-id");
    assert.ok(requestId && /^[0-9a-f-]{36}$/.test(requestId), "Expected server-generated request ID.");
    const record = logs.find((entry) => entry.requestId === requestId);
    assert.ok(record, "Expected a structured log matching the response request ID.");
    assert.equal(record.status, response.status);
    assert.equal(record.outcome, outcome);
    assert.ok(typeof record.durationMs === "number" && record.durationMs >= 0);
    return record;
  }
  const confirmedLog = diagnostic(booked, "confirmed");
  const replayLog = diagnostic(replayed, "replayed");
  const conflictLog = diagnostic(conflict, "OPERATION_CONFLICT");
  const otherLog = diagnostic(otherOwnerAttempt, "SOLD_OUT");
  diagnostic(health, "ready");
  assert.ok(typeof confirmedLog.operationId === "string" && /^[0-9a-f]{64}$/.test(confirmedLog.operationId));
  assert.equal(confirmedLog.operationId, replayLog.operationId);
  assert.equal(confirmedLog.operationId, conflictLog.operationId);
  assert.notEqual(confirmedLog.operationId, otherLog.operationId);
  assert.notEqual(booked.headers.get("x-request-id"), replayed.headers.get("x-request-id"));
  for (const secret of [token, operationKey, databaseUrl, otherCookie.split("=")[1]]) {
    assert.ok(!JSON.stringify(logs).includes(secret), "Sensitive value appeared in structured HTTP logs.");
  }
  async function history(suffix = "", ownerCookie = cookie?.split(";")[0] ?? "") {
    const response = await fetch(`${origin}/api/reservations${suffix}`, { headers: { Cookie: ownerCookie } });
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.has("set-cookie"), false);
    return response;
  }
  assert.equal((await history("", "")).status, 401);
  assert.equal((await history("?ownerId=forged")).status, 400);
  assert.deepEqual(await (await history("", otherCookie)).json(), { reservations: [], nextCursor: null });
  assert.deepEqual(await (await history()).json(), { reservations: [booking], nextCursor: null });
  const otherCursor = await history(`?before=${String(booking.reference)}`, otherCookie);
  const unknownCursor = await history(`?before=${randomUUID()}`, otherCookie);
  assert.equal(otherCursor.status, 404);
  assert.equal(unknownCursor.status, 404);
  assert.equal(await otherCursor.text(), await unknownCursor.text());
  // Consistent multi-page persisted fixture; the actual booking/retry above remains one row.
  await pool.query("UPDATE lastresort.events SET capacity=23 WHERE id=$1", [bookingEventId]);
  await pool.query(
    `INSERT INTO lastresort.reservations (reference, guest_session_id, event_id, quantity, status, created_at)
     SELECT gen_random_uuid(), owner.id, $1, 1, 'confirmed', clock_timestamp() - interval '1 day'
       FROM lastresort.guest_sessions AS owner CROSS JOIN generate_series(1, 22)
      WHERE owner.token_hash=$2`, [bookingEventId, createdTokenHash],
  );
  const firstPage = await (await history()).json();
  assert.equal(firstPage.reservations.length, 20);
  assert.ok(firstPage.nextCursor);
  const secondPage = await (await history(`?before=${firstPage.nextCursor}`)).json();
  assert.equal(secondPage.reservations.length, 3);
  assert.equal(secondPage.nextCursor, null);
  const references = [...firstPage.reservations, ...secondPage.reservations].map((item: { reference: string }) => item.reference);
  assert.equal(new Set(references).size, 23);
  for (const reference of [references[0], references.at(-1)]) {
    const detail: Response = await fetch(`${origin}/api/reservations/${reference}`, { headers: { Cookie: cookie.split(";")[0] } });
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).reference, reference);
  }
  assert.deepEqual(await (await history("", otherCookie)).json(), { reservations: [], nextCursor: null });
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM lastresort.reservations WHERE event_id=$1", [bookingEventId])).rows[0].count, 23);
  assert.equal((await pool.query("SELECT remaining FROM lastresort.events WHERE id=$1", [bookingEventId])).rows[0].remaining, 0);
  process.stdout.write("Production-server session, idempotent-booking, response-loss recovery, owned-result, history and structured-diagnostic HTTP checks passed.\n");
} finally {
  if (createdBookingFixture) {
    await pool.query("DELETE FROM lastresort.booking_operations WHERE event_id = $1", [bookingEventId]).catch(() => {});
    await pool.query("DELETE FROM lastresort.reservations WHERE event_id = $1", [bookingEventId]).catch(() => {});
    await pool.query("DELETE FROM lastresort.events WHERE id = $1", [bookingEventId]).catch(() => {});
  }
  if (createdTokenHash) {
    await pool.query("DELETE FROM lastresort.guest_sessions WHERE token_hash = $1", [createdTokenHash]).catch(() => {});
  }
  if (otherTokenHash) {
    await pool.query("DELETE FROM lastresort.guest_sessions WHERE token_hash = $1", [otherTokenHash]).catch(() => {});
  }
  if (server) await stopServer(server);
  await pool.end();
}
