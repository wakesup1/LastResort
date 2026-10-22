import { getPool } from "../../../server/database.ts";
import { checkHealth } from "../../../server/health.ts";
import { invalidRequest } from "../../../server/http.ts";
import { withRequestDiagnostics } from "../../../server/diagnostics.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return withRequestDiagnostics("health", request, () => readHealth(request));
}

async function readHealth(request: Request) {
  if (new URL(request.url).searchParams.size > 0) {
    return invalidRequest("This endpoint does not accept query parameters.");
  }
  const result = await checkHealth((sql) => getPool().query(sql));
  return Response.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
}
