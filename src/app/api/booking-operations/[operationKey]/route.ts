import { getPool } from "../../../../server/database.ts";
import { invalidRequest } from "../../../../server/http.ts";
import { readBookingOperation } from "../../../../server/reservations.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request, context: { params: Promise<{ operationKey: string }> }) {
  const { operationKey } = await context.params;
  if (!UUID_PATTERN.test(operationKey) || new URL(request.url).searchParams.size > 0) {
    return invalidRequest("Provide a valid booking operation key without query parameters.");
  }
  try {
    const result = await readBookingOperation(getPool(), request.headers.get("cookie"), operationKey.toLowerCase());
    if ("outcome" in result) return Response.json(result, { headers: noStore });
    const sessionRequired = result.code === "SESSION_REQUIRED";
    return Response.json({ error: {
      code: result.code,
      message: sessionRequired ? "A valid guest session is required." : "No completed operation is available for this session. The booking outcome remains unknown.",
    } }, { status: sessionRequired ? 401 : 404, headers: noStore });
  } catch {
    return Response.json({ error: { code: "SERVICE_UNAVAILABLE", message: "The booking outcome could not be loaded. Try checking it again." } }, { status: 503, headers: noStore });
  }
}
