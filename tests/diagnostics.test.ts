import { afterEach, describe, expect, it, vi } from "vitest";
import { reportDatabaseUnavailable, withRequestDiagnostics } from "../src/server/diagnostics.ts";

afterEach(() => { vi.restoreAllMocks(); });

describe("safe structured diagnostics", () => {
  it("measures handler duration with the monotonic clock", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValueOnce(125.5);
    await withRequestDiagnostics("health", new Request("https://example.test/api/health"), async () => Response.json({ status: "ok", database: "ready" }));
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ durationMs: 25.5, status: 200, outcome: "ready" });
  });

  it("correlates retries with fresh request IDs and bounded structured fields", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const key = "6bda9f21-c452-44fa-9468-f34f59159f31";
    const responses = await Promise.all([201, 200].map((status) => withRequestDiagnostics(
      "reservations.create", new Request("https://example.test/api/reservations", { headers: { "Idempotency-Key": key, "X-Request-Id": "untrusted" } }),
      async (diagnostics) => {
        diagnostics.operationId = "1".repeat(64);
        return Response.json({ reference: "private-reference" }, { status });
      },
    )));
    const records = log.mock.calls.map(([line]) => JSON.parse(line));
    expect(new Set(records.map((record) => record.requestId)).size).toBe(2);
    expect(records.map((record) => record.requestId)).toEqual(responses.map((response) => response.headers.get("x-request-id")));
    expect(records.map((record) => record.outcome)).toEqual(["confirmed", "replayed"]);
    expect(records[0].operationKeyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(records[0].operationKeyHash).toBe(records[1].operationKeyHash);
    expect(records[0].operationId).toBe(records[1].operationId);
    for (const record of records) {
      expect(record.durationMs).toBeGreaterThanOrEqual(0);
      expect(Object.keys(record).sort()).toEqual(["timestamp", "level", "event", "route", "requestId", "status", "outcome", "durationMs", "operationKeyHash", "operationId"].sort());
    }
    expect(JSON.stringify(records)).not.toContain(key);
    expect(JSON.stringify(records)).not.toContain("private-reference");
    expect(JSON.stringify(records)).not.toContain("untrusted");
  });

  it("records sanitized failures without headers, bodies, URLs or exception details", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const request = new Request("https://example.test/api/reservations?owner=query-secret", {
      method: "POST", headers: { Cookie: "lastresort_guest=cookie-secret", Authorization: "Bearer auth-secret", "Idempotency-Key": "invalid-secret" },
      body: '{"ownerId":"body-secret"}',
    });
    const response = await withRequestDiagnostics("reservations.create", request, async () => { throw new Error("postgresql://private:password-secret@internal/database"); });
    expect(response.status).toBe(503);
    const record = JSON.parse(log.mock.calls[0][0]);
    expect(record).toMatchObject({ level: "error", status: 503, outcome: "SERVICE_UNAVAILABLE" });
    for (const secret of ["query-secret", "cookie-secret", "auth-secret", "invalid-secret", "body-secret", "password-secret"]) {
      expect(JSON.stringify(record)).not.toContain(secret);
      expect(JSON.stringify(await response.clone().json())).not.toContain(secret);
    }
    expect(record.operationKeyHash).toBeUndefined();
  });

  it("keeps health readiness truthful when its handler fails", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const response = await withRequestDiagnostics("health", new Request("https://example.test/api/health"), async () => { throw new Error("private"); });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "unavailable", database: "unavailable" });
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ route: "health", level: "error", outcome: "unavailable" });
  });

  it("excludes arbitrary error codes and messages from log fields", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await withRequestDiagnostics("reservations.create", new Request("https://example.test/api/reservations"), async () => Response.json({ error: { code: "secret-code", message: "secret-message" } }, { status: 409 }));
    expect(log.mock.calls[0][0]).not.toContain("secret");
    expect(JSON.parse(log.mock.calls[0][0]).outcome).toBe("rejected");
  });

  it("logs pool outages safely and preserves successful responses if the log sink fails", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    reportDatabaseUnavailable();
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ level: "error", event: "database_connection", outcome: "unavailable" });
    log.mockImplementation(() => { throw new Error("Log unavailable"); });
    const response = await withRequestDiagnostics("reservations.create", new Request("https://example.test/api/reservations"), async () => Response.json({ status: "confirmed" }, { status: 201 }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ status: "confirmed" });
  });
});
