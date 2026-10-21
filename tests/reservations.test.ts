import SwaggerParser from "@apidevtools/swagger-parser";
import { Ajv, type AnySchemaObject } from "ajv";
import addFormats from "ajv-formats";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../src/app/api/reservations/route.ts";

const { query, connect, release } = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn(), release: vi.fn() }));
vi.mock("../src/server/database.ts", () => ({ getPool: () => ({ connect }) }));
const ownerId = "65b95c90-6a7f-4378-ad84-3aacd97cc593";
const reference = "6bda9f21-c452-44fa-9468-f34f59159f31";
const event = { id: "live-sessions-demo", name: "Live Sessions (Demo)", starts_at: new Date("2026-11-21T12:00:00Z"), venue: "Demo Hall", ticket_type: "General admission" };
const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
let responses: Record<string, { content: Record<string, { schema: AnySchemaObject }> }>;

beforeAll(async () => {
  const contract = await SwaggerParser.validate("api/openapi.json", { resolve: { external: false } });
  responses = contract.paths?.["/api/reservations"]?.post?.responses as unknown as typeof responses;
});

function request(body: unknown = { eventId: event.id, quantity: 1 }, headers: Record<string, string> = {}, url = "https://example.test/api/reservations") {
  return new Request(url, {
    method: "POST",
    headers: { Origin: "https://example.test", "Content-Type": "application/json", Cookie: `lastresort_guest=${"A".repeat(43)}`, ...headers },
    body: JSON.stringify(body),
  });
}

async function expectResponse(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body: unknown = await response.json();
  const validate = ajv.compile(responses[status].content["application/json"].schema);
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  return body;
}

beforeEach(() => {
  vi.clearAllMocks();
  query.mockReset();
  connect.mockReset();
  connect.mockResolvedValue({ query, release });
  query.mockImplementation(async (sql: string) => {
    if (sql.includes("SELECT id\n")) return { rows: [{ id: ownerId }] };
    if (sql.includes("FOR UPDATE")) return { rows: [{ id: event.id }] };
    if (sql.includes("UPDATE lastresort.events")) return { rows: [event] };
    if (sql.includes("INSERT INTO lastresort.reservations")) return { rows: [{ reference, created_at: new Date("2026-10-21T09:00:00Z") }] };
    return { rows: [] };
  });
});

describe("reservation HTTP boundary and transaction", () => {
  it("returns the confirmed reference only after commit and keeps ownership out of the response", async () => {
    const body = await expectResponse(await POST(request()), 201);
    expect(body).toEqual({ reference, status: "confirmed", quantity: 1, createdAt: "2026-10-21T09:00:00.000Z", event: { eventId: event.id, name: event.name, startsAt: event.starts_at.toISOString(), venue: event.venue, ticketType: event.ticket_type } });
    expect(query).toHaveBeenLastCalledWith("COMMIT");
    expect(query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO lastresort.reservations"), [expect.any(String), ownerId, event.id]);
    expect(release).toHaveBeenCalledOnce();
  });

  it.each(["", "null", "https://attacker.test"])("rejects Origin %s without database access", async (Origin) => {
    await expectResponse(await POST(request(undefined, { Origin })), 403);
    expect(connect).not.toHaveBeenCalled();
  });

  it.each([
    null, [], {}, { eventId: event.id }, { eventId: event.id, quantity: 2 },
    { eventId: event.id, quantity: "1" }, { eventId: "bad--id", quantity: 1 },
    { eventId: "x".repeat(101), quantity: 1 }, { eventId: event.id, quantity: 1, ownerId },
    { eventId: event.id, quantity: 1, sessionToken: "forged" },
  ])("rejects invalid input %j before database access", async (body) => {
    await expectResponse(await POST(request(body)), 400);
    expect(connect).not.toHaveBeenCalled();
  });

  it("rejects unsupported query parameters and retry keys before database access", async () => {
    await expectResponse(await POST(request(undefined, {}, "https://example.test/api/reservations?owner=forged")), 400);
    await expectResponse(await POST(request(undefined, { "Idempotency-Key": reference })), 400);
    expect(connect).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON, oversized bodies, and unsupported media types", async () => {
    for (const body of ["{", " ".repeat(1025)]) {
      await expectResponse(await POST(new Request("https://example.test/api/reservations", { method: "POST", headers: { Origin: "https://example.test", "Content-Type": "application/json" }, body })), 400);
    }
    await expectResponse(await POST(request(undefined, { "Content-Type": "text/plain" })), 415);
    expect(connect).not.toHaveBeenCalled();
  });

  it("requires a previously established session and never creates an owner while booking", async () => {
    await expectResponse(await POST(request(undefined, { Cookie: "lastresort_guest=forged" })), 401);
    expect(query.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "ROLLBACK"]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects a well-formed cookie with no valid stored session before touching inventory", async () => {
    query.mockResolvedValue({ rows: [] });
    await expectResponse(await POST(request()), 401);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("UPDATE lastresort.events"))).toBe(false);
  });

  it("returns not found without creating an entitlement", async () => {
    query.mockImplementation(async (sql: string) => ({ rows: sql.includes("token_hash") ? [{ id: ownerId }] : [] }));
    await expectResponse(await POST(request()), 404);
    expect(query).toHaveBeenLastCalledWith("ROLLBACK");
  });

  it.each(["SALES_NOT_OPEN", "SALES_CLOSED", "SOLD_OUT"])("rolls back %s", async (code) => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("token_hash")) return { rows: [{ id: ownerId }] };
      if (sql.includes("FOR UPDATE")) return { rows: [{ id: event.id }] };
      if (sql.includes("SELECT CASE")) return { rows: [{ code }] };
      return { rows: [] };
    });
    expect(await expectResponse(await POST(request()), 409)).toMatchObject({ error: { code } });
    expect(query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO lastresort.reservations"))).toBe(false);
  });

  it.each(["INSERT INTO lastresort.reservations", "COMMIT"])("never reports success when %s fails", async (failingSql) => {
    const implementation = query.getMockImplementation();
    query.mockImplementation(async (sql: string, ...args: unknown[]) => {
      if (sql.includes(failingSql)) throw new Error("postgresql://private:secret@internal/database");
      return implementation?.(sql, ...args);
    });
    const body = await expectResponse(await POST(request()), 503);
    expect(JSON.stringify(body)).not.toContain("private");
    expect(query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(release).toHaveBeenCalledOnce();
  });

  it("returns a safe error when acquiring a connection fails", async () => {
    connect.mockRejectedValue(new Error("secret"));
    expect(await expectResponse(await POST(request()), 503)).toMatchObject({ error: { code: "SERVICE_UNAVAILABLE" } });
    expect(release).not.toHaveBeenCalled();
  });
});
