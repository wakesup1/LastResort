import { ensureGuestSession } from "../../../server/guest-session.ts";
import { getPool } from "../../../server/database.ts";
import { forbiddenOrigin, getExpectedOrigin, hasRequestBody, invalidRequest, isSameOriginRequest } from "../../../server/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  const expectedOrigin = getExpectedOrigin(request);
  if (!expectedOrigin || !isSameOriginRequest(request, expectedOrigin)) return forbiddenOrigin();
  if (new URL(request.url).searchParams.size > 0) {
    return invalidRequest("This endpoint does not accept query parameters.");
  }
  if (await hasRequestBody(request)) {
    return invalidRequest("This endpoint does not accept a request body.");
  }

  try {
    const result = await ensureGuestSession(
      (sql, values) => getPool().query(sql, values),
      request.headers.get("cookie"),
      new URL(expectedOrigin).protocol === "https:",
    );
    const headers = new Headers(noStore);
    if (result.setCookie) headers.set("Set-Cookie", result.setCookie);
    return new Response(null, { status: 204, headers });
  } catch {
    return Response.json(
      { error: { code: "SERVICE_UNAVAILABLE", message: "The service is temporarily unavailable." } },
      { status: 503, headers: noStore },
    );
  }
}
