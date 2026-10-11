type Query = (sql: string) => Promise<unknown>;

export async function checkHealth(query: Query) {
  try {
    await query("SELECT id FROM lastresort.events LIMIT 1");
    return { status: 200, body: { status: "ok", database: "ready" } };
  } catch {
    return { status: 503, body: { status: "unavailable", database: "unavailable" } };
  }
}
