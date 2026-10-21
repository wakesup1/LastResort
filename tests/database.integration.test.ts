import { execFileSync } from "node:child_process";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableDatabase } from "../src/server/config.ts";
import { checkHealth } from "../src/server/health.ts";
import { createGuestSession, GUEST_SESSION_COOKIE_NAME, resolveGuestSession } from "../src/server/guest-session.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("Missing configuration: TEST_DATABASE_URL (dedicated lastresort_test database required)");
const pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 3000 });

function command(action: string, appEnv = "test", ...args: string[]) {
  return execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/database.ts", action, ...args], {
    env: { ...process.env, APP_ENV: appEnv, DATABASE_URL: databaseUrl },
    encoding: "utf8", stdio: "pipe", timeout: 15000,
  });
}

beforeAll(async () => {
  const result = await pool.query("SELECT current_database() AS name");
  assertDisposableDatabase({ appEnv: "test", databaseUrl: databaseUrl! }, result.rows[0].name);
  command("migrate");
  const marker = await pool.query("SELECT name FROM lastresort.environment WHERE id=1");
  if (!marker.rows[0]) throw new Error("Missing database environment marker");
  assertDisposableDatabase({ appEnv: "test", databaseUrl: databaseUrl! }, result.rows[0].name, marker.rows[0].name);
});
afterAll(async () => { await pool.end(); });

describe("PostgreSQL foundation commands", () => {
  it("migrates repeatedly and seeds exactly one complete event", async () => {
    command("reset", "test", "--confirm-reset");
    command("migrate");
    command("seed");
    command("seed");
    const events = await pool.query("SELECT * FROM lastresort.events");
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]).toMatchObject({ id: "live-sessions-demo", capacity: 100, remaining: 100, price_minor: 0, venue: "Demo Hall", ticket_type: "General admission" });
    expect((await pool.query("SELECT * FROM lastresort.migrations")).rows).toHaveLength(3);
    expect(await checkHealth((sql) => pool.query(sql))).toMatchObject({ status: 200 });
  });
  it("seed does not replenish inventory", async () => {
    await pool.query("UPDATE lastresort.events SET remaining=99");
    command("seed");
    expect((await pool.query("SELECT remaining FROM lastresort.events")).rows[0].remaining).toBe(99);
  });
  it("refuses an unconfirmed reset without changing data", async () => {
    expect(() => command("reset")).toThrow();
    expect((await pool.query("SELECT remaining FROM lastresort.events")).rows[0].remaining).toBe(99);
  });
  it("refuses a production environment without changing data", async () => {
    expect(() => command("reset", "production", "--confirm-reset")).toThrow();
    expect((await pool.query("SELECT remaining FROM lastresort.events")).rows[0].remaining).toBe(99);
  });
  it("refuses a production database marker even when APP_ENV says test", async () => {
    await pool.query("UPDATE lastresort.environment SET name='production' WHERE id=1");
    try {
      expect(() => command("reset", "test", "--confirm-reset")).toThrow();
      expect((await pool.query("SELECT remaining FROM lastresort.events")).rows[0].remaining).toBe(99);
    } finally {
      await pool.query("UPDATE lastresort.environment SET name='test' WHERE id=1");
    }
  });
  it("resets confirmed test data and preserves other schemas", async () => {
    await pool.query("CREATE TABLE IF NOT EXISTS public.foundation_sentinel (id int PRIMARY KEY)");
    await pool.query("INSERT INTO public.foundation_sentinel VALUES (1) ON CONFLICT DO NOTHING");
    await createGuestSession((sql, values) => pool.query(sql, values));
    command("reset", "test", "--confirm-reset");
    expect((await pool.query("SELECT remaining FROM lastresort.events")).rows[0].remaining).toBe(100);
    expect((await pool.query("SELECT id FROM lastresort.guest_sessions")).rows).toHaveLength(0);
    expect((await pool.query("SELECT * FROM public.foundation_sentinel")).rows).toHaveLength(1);
    await pool.query("DROP TABLE public.foundation_sentinel");
  });

  it("persists distinct guest owners, stores token hashes, and rejects expired sessions", async () => {
    const query = (sql: string, values: string[]) => pool.query(sql, values);
    const first = await createGuestSession(query);
    const second = await createGuestSession(query);
    const firstToken = first.setCookie.split(";")[0]?.split("=")[1] ?? "";
    const secondToken = second.setCookie.split(";")[0]?.split("=")[1] ?? "";

    expect(await resolveGuestSession(query, `${GUEST_SESSION_COOKIE_NAME}=${firstToken}`)).toEqual(first.session);
    expect(await resolveGuestSession(query, `${GUEST_SESSION_COOKIE_NAME}=${secondToken}`)).toEqual(second.session);
    expect(first.session.ownerId).not.toBe(second.session.ownerId);
    const hashes = await pool.query("SELECT token_hash FROM lastresort.guest_sessions WHERE id = ANY($1::uuid[])", [[first.session.ownerId, second.session.ownerId]]);
    expect(hashes.rows.map((row: { token_hash: string }) => row.token_hash)).not.toContain(firstToken);
    expect(hashes.rows.map((row: { token_hash: string }) => row.token_hash)).not.toContain(secondToken);

    await pool.query("UPDATE lastresort.guest_sessions SET expires_at = now() - interval '1 second' WHERE id = $1", [first.session.ownerId]);
    expect(await resolveGuestSession(query, `${GUEST_SESSION_COOKIE_NAME}=${firstToken}`)).toBeNull();
    expect(await resolveGuestSession(query, `${GUEST_SESSION_COOKIE_NAME}=${secondToken}`)).toEqual(second.session);
  });
});
