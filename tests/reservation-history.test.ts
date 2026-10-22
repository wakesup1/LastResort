import SwaggerParser from "@apidevtools/swagger-parser";
import { Ajv, type AnySchemaObject } from "ajv";
import addFormats from "ajv-formats";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../src/app/api/reservations/route.ts";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../src/server/database.ts", () => ({ getPool: () => ({ query }) }));
const ownerId = "65b95c90-6a7f-4378-ad84-3aacd97cc593";
const cursor = "6bda9f21-c452-44fa-9468-f34f59159f31";
const cookie = `lastresort_guest=${"A".repeat(43)}`;
const ajv = new Ajv();
addFormats(ajv);
let responses: Record<string, { content: Record<string, { schema: AnySchemaObject }> }>;
beforeAll(async () => {
  const contract = await SwaggerParser.validate("api/openapi.json", { resolve: { external: false } });
  responses = contract.paths?.["/api/reservations"]?.get?.responses as unknown as typeof responses;
});
beforeEach(() => { query.mockReset(); });
function read(suffix = "", sessionCookie = cookie) {
  return GET(new Request(`http://localhost/api/reservations${suffix}`, { headers: { Cookie: sessionCookie } }));
}
async function expectResponse(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.has("set-cookie")).toBe(false);
  const body: unknown = await response.json();
  const validate = ajv.compile(responses[status].content["application/json"].schema);
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  return body;
}
function rows(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    reference: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    id: "live-sessions-demo", name: "Demo", starts_at: new Date("2026-11-21T12:00:00Z"), venue: "Hall",
    ticket_type: "General admission", created_at: new Date("2026-10-21T09:00:00Z"),
  }));
}
describe("guest booking history (S2-05)", () => {
  it("returns several owned tickets and only performs owner-scoped reads", async () => {
    query.mockResolvedValueOnce({ rows: [{ id: ownerId }] }).mockResolvedValueOnce({ rows: rows(2) });
    expect(await expectResponse(await read(), 200)).toMatchObject({ reservations: [{ reference: rows(2)[0].reference }, { reference: rows(2)[1].reference }], nextCursor: null });
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining("reservation.guest_session_id = $1"), [ownerId, null]);
    expect(query.mock.calls.every(([sql]) => String(sql).trim().startsWith("SELECT") || String(sql).trim().startsWith("WITH"))).toBe(true);
  });
  it("returns an empty page for a new valid owner", async () => {
    query.mockResolvedValueOnce({ rows: [{ id: ownerId }] }).mockResolvedValueOnce({ rows: [] });
    expect(await expectResponse(await read(), 200)).toEqual({ reservations: [], nextCursor: null });
  });
  it("bounds a page to 20 tickets with a continuation reference", async () => {
    query.mockResolvedValueOnce({ rows: [{ id: ownerId }] }).mockResolvedValueOnce({ rows: rows(21) });
    const body = await expectResponse(await read(), 200);
    expect(body).toMatchObject({ nextCursor: rows(20)[19].reference });
    expect(body).toHaveProperty("reservations.length", 20);
  });
  it("checks cursor ownership and uses a database timestamp for pagination", async () => {
    query.mockResolvedValueOnce({ rows: [{ id: ownerId }] }).mockResolvedValueOnce({ rows: [{ reference: cursor }] }).mockResolvedValueOnce({ rows: rows(1) });
    await expectResponse(await read(`?before=${cursor}`), 200);
    expect(query.mock.calls[1][1]).toEqual([cursor, ownerId]);
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining("reservation.created_at = cursor.created_at"), [ownerId, cursor]);
  });
  it("returns identical 404s for missing and cross-owner cursors", async () => {
    query.mockResolvedValueOnce({ rows: [{ id: ownerId }] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: ownerId }] }).mockResolvedValueOnce({ rows: [] });
    const first = await expectResponse(await read(`?before=${cursor}`), 404);
    expect(await expectResponse(await read(`?before=${rows(1)[0].reference}`), 404)).toEqual(first);
    expect(query).toHaveBeenCalledTimes(4);
  });
  it.each(["?ownerId=forged", "?sessionToken=secret", "?before=bad", "?before=", `?before=${cursor}&before=${cursor}`, "?limit=500"])("rejects unsupported input %s before DB access", async (suffix) => {
    await expectResponse(await read(suffix), 400);
    expect(query).not.toHaveBeenCalled();
  });
  it.each(["", "lastresort_guest=forged"])("rejects absent/forged cookies without creating a session", async (sessionCookie) => {
    await expectResponse(await read("", sessionCookie), 401);
    expect(query).not.toHaveBeenCalled();
  });
  it("rejects an expired session before reading bookings", async () => {
    query.mockResolvedValue({ rows: [] });
    await expectResponse(await read(), 401);
    expect(query).toHaveBeenCalledOnce();
  });
  it("returns a safe 503 rather than an empty list when the database fails", async () => {
    query.mockRejectedValue(new Error("postgresql://private:secret@internal/database"));
    const body = await expectResponse(await read(), 503);
    expect(body).toMatchObject({ error: { code: "SERVICE_UNAVAILABLE" } });
    expect(JSON.stringify(body)).not.toContain("secret");
  });
});
