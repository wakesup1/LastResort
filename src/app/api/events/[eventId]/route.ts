import { getPool } from "../../../../server/database.ts";
import { readEvent } from "../../../../server/events.ts";
import { invalidRequest } from "../../../../server/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EVENT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const noStore = { "Cache-Control": "no-store" };

function errorResponse(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status, headers: noStore });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ eventId: string }> },
) {
  if (new URL(request.url).searchParams.size > 0) {
    return invalidRequest("This endpoint does not accept query parameters.");
  }

  const { eventId } = await context.params;
  if (typeof eventId !== "string" || eventId.length < 1 || eventId.length > 100 || !EVENT_ID_PATTERN.test(eventId)) {
    return invalidRequest("eventId must contain lowercase letters, numbers, and single hyphens.");
  }

  try {
    const event = await readEvent((sql, values) => getPool().query(sql, values), eventId);
    if (!event) {
      return errorResponse(404, "NOT_FOUND", "The requested event was not found.");
    }
    return Response.json(event, { status: 200, headers: noStore });
  } catch {
    // Database and configuration errors may include credentials or connection details.
    return errorResponse(503, "SERVICE_UNAVAILABLE", "The service is temporarily unavailable.");
  }
}
