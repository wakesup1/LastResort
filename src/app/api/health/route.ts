import { getPool } from "../../../server/database.ts";
import { checkHealth } from "../../../server/health.ts";
import { invalidRequest } from "../../../server/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (new URL(request.url).searchParams.size > 0) {
    return invalidRequest("This endpoint does not accept query parameters.");
  }
  const result = await checkHealth((sql) => getPool().query(sql));
  return Response.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
}
