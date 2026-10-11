import { getPool } from "../../../server/database.ts";
import { checkHealth } from "../../../server/health.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const result = await checkHealth((sql) => getPool().query(sql));
  return Response.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
}
