export function invalidRequest(message: string) {
  return Response.json(
    { error: { code: "INVALID_REQUEST", message } },
    { status: 400, headers: { "Cache-Control": "no-store" } },
  );
}

export function forbiddenOrigin() {
  return Response.json(
    { error: { code: "ORIGIN_FORBIDDEN", message: "This endpoint accepts same-origin requests only." } },
    { status: 403, headers: { "Cache-Control": "no-store" } },
  );
}

export function isSameOriginRequest(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;

  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}
