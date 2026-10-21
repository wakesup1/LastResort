import SwaggerParser from "@apidevtools/swagger-parser";
import { Ajv, type AnySchemaObject } from "ajv";
import addFormats from "ajv-formats";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../src/app/api/reservations/[reference]/route.ts";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../src/server/database.ts", () => ({ getPool: () => ({ query }) }));
const reference = "6bda9f21-c452-44fa-9468-f34f59159f31";
const ownerId = "65b95c90-6a7f-4378-ad84-3aacd97cc593";
const ajv = new Ajv();
addFormats(ajv);
let responses: Record<string, { content: Record<string, { schema: AnySchemaObject }> }>;
beforeAll(async () => {
  const contract = await SwaggerParser.validate("api/openapi.json", { resolve: { external: false } });
  responses = contract.paths?.["/api/reservations/{reference}"]?.get?.responses as unknown as typeof responses;
});
beforeEach(() => { query.mockReset(); });
function read(ref = reference, cookie = `lastresort_guest=${"A".repeat(43)}`, suffix = "") {
  return GET(new Request(`http://localhost/api/reservations/${ref}${suffix}`, { headers: { Cookie: cookie } }), { params: Promise.resolve({ reference: ref }) });
}
async function expectResponse(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body: unknown = await response.json();
  const validate = ajv.compile(responses[status].content["application/json"].schema);
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  return body;
}
describe("owned reservation reads (S1-12)", () => {
  it("returns the original reference and status with an owner-scoped read and no mutations", async () => {
    query.mockResolvedValueOnce({ rows: [{ id: ownerId }] }).mockResolvedValueOnce({ rows: [{ id: "live-sessions-demo", name: "Demo", starts_at: new Date("2026-11-21T12:00:00Z"), venue: "Hall", ticket_type: "General admission", reference, created_at: new Date("2026-10-21T09:00:00Z") }] });
    expect(await expectResponse(await read(), 200)).toMatchObject({ reference, status: "confirmed", quantity: 1 });
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining("reservation.guest_session_id = $2"), [reference, ownerId]);
    expect(query.mock.calls.every(([sql]) => String(sql).trim().startsWith("SELECT"))).toBe(true);
  });
  it.each(["bad-reference", "'; DROP TABLE reservations; --"])("rejects malformed references before database access", async (ref) => {
    await expectResponse(await read(ref), 400);
    expect(query).not.toHaveBeenCalled();
  });
  it("rejects client-supplied owner query parameters before database access", async () => {
    await expectResponse(await read(reference, "", "?ownerId=forged"), 400);
    expect(query).not.toHaveBeenCalled();
  });
  it.each(["", "lastresort_guest=forged"])("requires a valid cookie before reading reservations", async (cookie) => {
    await expectResponse(await read(reference, cookie), 401);
    expect(query).not.toHaveBeenCalled();
  });
  it("rejects missing/expired stored sessions without reading reservations", async () => {
    query.mockResolvedValue({ rows: [] });
    await expectResponse(await read(), 401);
    expect(query).toHaveBeenCalledOnce();
  });
  it("returns the same not-found shape for unknown and cross-owner references", async () => {
    query.mockResolvedValueOnce({ rows: [{ id: ownerId }] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: ownerId }] }).mockResolvedValueOnce({ rows: [] });
    const missing = await expectResponse(await read(), 404);
    expect(await expectResponse(await read("2d81fc2c-05e9-42aa-9786-2edf87238565"), 404)).toEqual(missing);
  });
  it("returns a safe, retryable read error without driver details", async () => {
    query.mockRejectedValue(new Error("postgresql://private:secret@internal/database"));
    const body = await expectResponse(await read(), 503);
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(body).toMatchObject({ error: { code: "SERVICE_UNAVAILABLE" } });
  });
});
