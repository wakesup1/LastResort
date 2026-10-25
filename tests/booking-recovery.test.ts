import SwaggerParser from "@apidevtools/swagger-parser";
import { Ajv, type AnySchemaObject } from "ajv";
import addFormats from "ajv-formats";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../src/app/api/booking-operations/[operationKey]/route.ts";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../src/server/database.ts", () => ({ getPool: () => ({ query }) }));
const key = "7b013fc7-c29f-428e-98ea-04cbe234e917";
const ownerId = "65b95c90-6a7f-4378-ad84-3aacd97cc593";
const reservation = { reference: "6bda9f21-c452-44fa-9468-f34f59159f31", status: "confirmed", quantity: 1, createdAt: "2026-10-21T09:00:00Z", event: { eventId: "live-sessions-demo", name: "Demo", venue: "Hall", ticketType: "General admission", startsAt: "2026-11-21T12:00:00Z" } };
const ajv = new Ajv();
addFormats(ajv);
let responses: Record<string, { content: Record<string, { schema: AnySchemaObject }> }>;
beforeAll(async () => {
  const contract = await SwaggerParser.validate("api/openapi.json", { resolve: { external: false } });
  responses = contract.paths?.["/api/booking-operations/{operationKey}"]?.get?.responses as unknown as typeof responses;
});
beforeEach(() => { query.mockReset(); });
function read(operationKey = key, cookie = `lastresort_guest=${"A".repeat(43)}`, suffix = "") {
  return GET(new Request(`http://localhost/api/booking-operations/${operationKey}${suffix}`, { headers: { Cookie: cookie } }), { params: Promise.resolve({ operationKey }) });
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
describe("read-only booking recovery (S2-06)", () => {
  it("returns the persisted snapshot using only owner-scoped reads", async () => {
    query.mockResolvedValueOnce({ rows: [{ id: ownerId }] }).mockResolvedValueOnce({ rows: [{ event_id: "live-sessions-demo", response: { reservation } }] });
    expect(await expectResponse(await read(key.toUpperCase()), 200)).toEqual({ eventId: "live-sessions-demo", outcome: { reservation } });
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining("guest_session_id = $1 AND operation_key = $2"), [ownerId, key]);
    expect(query.mock.calls.every(([sql]) => String(sql).trim().startsWith("SELECT"))).toBe(true);
  });
  it.each(["NOT_FOUND", "SALES_NOT_OPEN", "SALES_CLOSED", "SOLD_OUT"])("returns a stored %s as a known outcome, distinct from an unknown operation", async (code) => {
    query.mockResolvedValueOnce({ rows: [{ id: ownerId }] }).mockResolvedValueOnce({ rows: [{ event_id: "live-sessions-demo", response: { code } }] });
    expect(await expectResponse(await read(), 200)).toEqual({ eventId: "live-sessions-demo", outcome: { code } });
  });
  it.each(["invalid", "';DROP TABLE bookings"])("rejects malformed keys before database access", async (value) => {
    await expectResponse(await read(value), 400);
    expect(query).not.toHaveBeenCalled();
  });
  it("rejects owner query parameters before database access", async () => {
    await expectResponse(await read(key, "", "?ownerId=forged"), 400);
    expect(query).not.toHaveBeenCalled();
  });
  it.each(["", "lastresort_guest=forged"])("never creates a replacement session for an invalid cookie", async (cookie) => {
    await expectResponse(await read(key, cookie), 401);
    expect(query).not.toHaveBeenCalled();
  });
  it("rejects expired sessions before reading operations", async () => {
    query.mockResolvedValue({ rows: [] });
    await expectResponse(await read(), 401);
    expect(query).toHaveBeenCalledOnce();
  });
  it("uses the same unknown response for missing, cross-owner and unfinished operations", async () => {
    const bodies = [];
    for (const rows of [[], [], [{ event_id: "live-sessions-demo", response: null }]]) {
      query.mockResolvedValueOnce({ rows: [{ id: ownerId }] }).mockResolvedValueOnce({ rows });
      bodies.push(await expectResponse(await read(), 404));
    }
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
  });
  it("keeps driver details out of read failures", async () => {
    query.mockRejectedValue(new Error("postgresql://private:secret@internal/database"));
    expect(JSON.stringify(await expectResponse(await read(), 503))).not.toContain("secret");
  });
});
