import { createHash, randomUUID } from "node:crypto";

type Route = "reservations.create" | "health";
export type RequestDiagnostics = { operationId?: string };
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const errorCodes = new Set([
  "INVALID_REQUEST", "ORIGIN_FORBIDDEN", "SESSION_REQUIRED", "NOT_FOUND", "SALES_NOT_OPEN",
  "SALES_CLOSED", "SOLD_OUT", "OPERATION_CONFLICT", "SERVICE_UNAVAILABLE", "INTERNAL_ERROR",
]);

function emit(record: Record<string, string | number>) {
  // Logging must never turn a committed booking into a failed HTTP response.
  try { console.log(JSON.stringify({ timestamp: new Date().toISOString(), ...record })); } catch {}
}

export function reportDatabaseUnavailable() {
  emit({ level: "error", event: "database_connection", outcome: "unavailable" });
}

export async function withRequestDiagnostics(route: Route, request: Request, handle: (diagnostics: RequestDiagnostics) => Promise<Response>) {
  const requestId = randomUUID();
  const startedAt = performance.now();
  let response: Response;
  const diagnostics: RequestDiagnostics = {};
  try {
    response = await handle(diagnostics);
  } catch {
    response = route === "health"
      ? Response.json({ status: "unavailable", database: "unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } })
      : Response.json({ error: { code: "SERVICE_UNAVAILABLE", message: "The booking outcome could not be confirmed. Retry only the same operation key and payload with the original session." } }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  let outcome = route === "health" ? (response.ok ? "ready" : "unavailable") : (response.status === 201 ? "confirmed" : response.status === 200 ? "replayed" : "rejected");
  try {
    const body: unknown = await response.clone().json();
    if (typeof body === "object" && body !== null && "error" in body &&
        typeof body.error === "object" && body.error !== null && "code" in body.error &&
        typeof body.error.code === "string" && errorCodes.has(body.error.code)) outcome = body.error.code;
  } catch {}
  const record: Record<string, string | number> = {
    level: response.status >= 500 ? "error" : response.status >= 400 ? "warn" : "info",
    event: "http_request", route, requestId, status: response.status, outcome,
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
  };
  const key = request.headers.get("Idempotency-Key");
  if (route === "reservations.create" && key && UUID_PATTERN.test(key)) {
    record.operationKeyHash = createHash("sha256").update(key.toLowerCase()).digest("hex");
  }
  if (diagnostics.operationId && /^[0-9a-f]{64}$/.test(diagnostics.operationId)) record.operationId = diagnostics.operationId;
  response.headers.set("X-Request-Id", requestId);
  emit(record);
  return response;
}
