const MAX_REQUEST_BODY_BYTES = 0n;
const MAX_EMPTY_BODY_PROBE_CHUNKS = 16;

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

export function getExpectedOrigin(request: Request, configuredOrigin = process.env.APP_ORIGIN) {
  const configured = configuredOrigin?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if (["http:", "https:"].includes(url.protocol) && url.origin === configured) return url.origin;
    } catch {
      return null;
    }
    return null;
  }

  try {
    const requestUrl = new URL(request.url);
    if (!["http:", "https:"].includes(requestUrl.protocol)) return null;

    // Next.js may normalize 127.0.0.1 to localhost in request.url. Use the
    // direct Host authority when present; never infer it from forwarded headers.
    const host = request.headers.get("host")?.trim() || requestUrl.host;
    if (!host || /[\s/@?#]/.test(host)) return null;

    const url = new URL(`${requestUrl.protocol}//${host}`);
    if (!url.hostname || url.username || url.password || url.pathname !== "/") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function isSameOriginRequest(request: Request, expectedOrigin = getExpectedOrigin(request)) {
  const origin = request.headers.get("origin");
  if (!origin || origin === "null" || !expectedOrigin) return false;

  try {
    const parsedOrigin = new URL(origin);
    return parsedOrigin.origin === origin && parsedOrigin.origin === expectedOrigin;
  } catch {
    return false;
  }
}

export async function hasRequestBody(request: Request) {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) return true;
    try {
      if (BigInt(contentLength) > MAX_REQUEST_BODY_BYTES) return true;
    } catch {
      return true;
    }
  }

  if (!request.body) return false;

  const reader = request.body.getReader();
  let emptyChunks = 0;
  try {
    while (emptyChunks < MAX_EMPTY_BODY_PROBE_CHUNKS) {
      const { done, value } = await reader.read();
      if (done) return false;
      if ((value?.byteLength ?? 0) > Number(MAX_REQUEST_BODY_BYTES)) return true;
      emptyChunks += 1;
    }
    return true;
  } catch {
    return true;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
