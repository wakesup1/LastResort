import { getPool } from "../../../server/database.ts";
import { forbiddenOrigin, invalidRequest, isSameOriginRequest } from "../../../server/http.ts";
import { readReservationHistory, reserveTicket } from "../../../server/reservations.ts";
import { withRequestDiagnostics, type RequestDiagnostics } from "../../../server/diagnostics.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };
const EVENT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_BODY_BYTES = 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorResponse(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status, headers: noStore });
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const before = params.get("before");
  if ([...params.keys()].some((key) => key !== "before") || params.getAll("before").length > 1 ||
      (before !== null && !UUID_PATTERN.test(before))) {
    return invalidRequest("Provide only one valid UUID before cursor, or no query parameters.");
  }
  try {
    const result = await readReservationHistory(getPool(), request.headers.get("cookie"), before);
    if (!("code" in result)) return Response.json(result, { headers: noStore });
    return result.code === "SESSION_REQUIRED"
      ? errorResponse(401, result.code, "A valid guest session is required.")
      : errorResponse(404, result.code, "The resource does not exist or does not belong to this session.");
  } catch {
    return errorResponse(503, "SERVICE_UNAVAILABLE", "Booking history could not be loaded. Try reading it again.");
  }
}

async function readBookingInput(request: Request): Promise<string | null> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || BigInt(length) > BigInt(MAX_BODY_BYTES))) return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let bytes = 0;
  let emptyChunks = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) return null;
      if (value.byteLength === 0 && ++emptyChunks >= 16) return null;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    const input: unknown = JSON.parse(text);
    if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
    if (!("eventId" in input) || !("quantity" in input) || Object.keys(input).length !== 2) return null;
    if (input.quantity !== 1 || typeof input.eventId !== "string") return null;
    if (input.eventId.length < 1 || input.eventId.length > 100 || !EVENT_ID_PATTERN.test(input.eventId)) return null;
    return input.eventId;
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function POST(request: Request) {
  return withRequestDiagnostics("reservations.create", request, (diagnostics) => createReservation(request, diagnostics));
}

async function createReservation(request: Request, diagnostics: RequestDiagnostics) {
  if (!isSameOriginRequest(request)) return forbiddenOrigin();
  if (new URL(request.url).searchParams.size > 0) {
    return invalidRequest("This endpoint does not accept query parameters.");
  }
  const operationKey = request.headers.get("Idempotency-Key");
  if (!operationKey || !UUID_PATTERN.test(operationKey)) {
    return invalidRequest("Provide one UUID Idempotency-Key for this booking operation.");
  }
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    return errorResponse(415, "INVALID_REQUEST", "Content-Type must be application/json.");
  }
  const eventId = await readBookingInput(request);
  if (!eventId) return invalidRequest("Provide only a valid eventId and quantity of 1 in JSON (maximum 1024 bytes).");

  try {
    const client = await getPool().connect();
    try {
      const result = await reserveTicket(client, request.headers.get("cookie"), eventId, operationKey.toLowerCase(), (id) => { diagnostics.operationId = id; });
      if ("reservation" in result) return Response.json(result.reservation, { status: result.replayed ? 200 : 201, headers: noStore });
      switch (result.code) {
        case "SESSION_REQUIRED": return errorResponse(401, result.code, "A valid guest session is required.");
        case "NOT_FOUND": return errorResponse(404, result.code, "The requested event was not found.");
        case "SALES_NOT_OPEN": return errorResponse(409, result.code, "Ticket sales have not opened yet.");
        case "SALES_CLOSED": return errorResponse(409, result.code, "Ticket sales have closed.");
        case "SOLD_OUT": return errorResponse(409, result.code, "No tickets are available.");
        case "OPERATION_CONFLICT": return errorResponse(409, result.code, "This operation key was already used with a different booking payload.");
      }
    } finally {
      client.release();
    }
  } catch {
    return errorResponse(503, "SERVICE_UNAVAILABLE", "The booking outcome could not be confirmed. Retry only the same operation key and payload with the original session.");
  }
}
