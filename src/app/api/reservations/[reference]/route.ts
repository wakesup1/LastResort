import { getPool } from "../../../../server/database.ts";
import { invalidRequest } from "../../../../server/http.ts";
import { readReservation } from "../../../../server/reservations.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request, context: { params: Promise<{ reference: string }> }) {
  const { reference } = await context.params;
  if (!UUID_PATTERN.test(reference) || new URL(request.url).searchParams.size > 0) {
    return invalidRequest("Provide a valid reservation reference without query parameters.");
  }
  try {
    const result = await readReservation(getPool(), request.headers.get("cookie"), reference);
    if ("reservation" in result) return Response.json(result.reservation, { headers: noStore });
    const sessionRequired = result.code === "SESSION_REQUIRED";
    return Response.json({ error: {
      code: sessionRequired ? "SESSION_REQUIRED" : "NOT_FOUND",
      message: sessionRequired ? "A valid guest session is required." : "The resource does not exist or does not belong to this session.",
    } }, { status: sessionRequired ? 401 : 404, headers: noStore });
  } catch {
    return Response.json({ error: { code: "SERVICE_UNAVAILABLE", message: "The reservation could not be loaded. Try reading it again." } }, { status: 503, headers: noStore });
  }
}
