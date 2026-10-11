export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { readConfig } = await import("./server/config.ts");
    readConfig();
  }
}
