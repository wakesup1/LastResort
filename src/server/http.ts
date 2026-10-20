export function invalidRequest(message: string) {
  return Response.json(
    { error: { code: "INVALID_REQUEST", message } },
    { status: 400, headers: { "Cache-Control": "no-store" } },
  );
}
