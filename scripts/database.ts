import nextEnv from "@next/env";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import { assertDisposableDatabase, ConfigError, readConfig } from "../src/server/config.ts";

nextEnv.loadEnvConfig(process.cwd());

async function seed(client: PoolClient) {
  // Re-running seed never restores tickets or overwrites an existing event.
  await client.query(`INSERT INTO lastresort.events
    (id, name, starts_at, venue, ticket_type, price_minor, sale_opens_at, sale_closes_at, capacity, remaining)
    VALUES ($1, $2, $3, $4, $5, 0, $6, $7, 100, 100) ON CONFLICT (id) DO NOTHING`,
  ["live-sessions-demo", "Live Sessions (Demo)", "2026-11-21T12:00:00Z", "Demo Hall", "General admission", "2026-10-01T00:00:00Z", "2026-11-21T11:00:00Z"]);
}

async function main() {
  const action = process.argv[2];
  if (!["migrate", "seed", "reset", "status"].includes(action)) throw new Error("Use migrate, seed, reset or status.");
  const config = readConfig();
  const pool = new Pool({ connectionString: config.databaseUrl, connectionTimeoutMillis: 3000, statement_timeout: 10000 });
  try {
    const client = await pool.connect();
    try {
      const info = await client.query("SELECT current_database() AS name, current_setting('server_version_num')::int AS version");
      if (Math.floor(info.rows[0].version / 10000) !== 17) throw new Error("PostgreSQL 17 is required.");
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(7101105)");
      if (action === "migrate") {
        await client.query("CREATE SCHEMA IF NOT EXISTS lastresort");
        await client.query(`CREATE TABLE IF NOT EXISTS lastresort.environment
          (id integer PRIMARY KEY CHECK (id = 1), name text NOT NULL CHECK (name IN ('test', 'demo', 'production')))`);
        await client.query("INSERT INTO lastresort.environment VALUES (1, $1) ON CONFLICT DO NOTHING", [config.appEnv]);
        const marker = await client.query("SELECT name FROM lastresort.environment WHERE id=1");
        if (marker.rows[0]?.name !== config.appEnv) throw new Error("Database environment marker does not match APP_ENV.");
        await client.query("CREATE TABLE IF NOT EXISTS lastresort.migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
        const directory = fileURLToPath(new URL("../db/migrations/", import.meta.url));
        for (const name of (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort()) {
          const applied = await client.query("SELECT 1 FROM lastresort.migrations WHERE name=$1", [name]);
          if (!applied.rowCount) {
            await client.query(await readFile(`${directory}/${name}`, "utf8"));
            await client.query("INSERT INTO lastresort.migrations (name) VALUES ($1)", [name]);
          }
        }
      } else if (action === "status") {
        const events = await client.query("SELECT id, name, capacity, remaining FROM lastresort.events ORDER BY id");
        console.log(JSON.stringify(events.rows, null, 2));
      } else {
        // Check actual connected database AND its persisted environment before any mutation.
        assertDisposableDatabase(config, info.rows[0].name);
        const marker = await client.query("SELECT name FROM lastresort.environment WHERE id=1");
        if (!marker.rows[0]) throw new Error("Database environment marker missing; seed/reset refused.");
        assertDisposableDatabase(config, info.rows[0].name, marker.rows[0].name);
        if (action === "reset") {
          if (process.argv[3] !== "--confirm-reset") throw new Error("Reset requires --confirm-reset (test/demo data only).");
          // Explicit table list: never DROP schemas or TRUNCATE ... CASCADE.
          await client.query("TRUNCATE TABLE lastresort.booking_operations, lastresort.reservations, lastresort.guest_sessions, lastresort.events");
        }
        await seed(client);
      }
      await client.query("COMMIT");
      console.log(`Database ${action} completed.`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  const safeMessages = ["PostgreSQL 17 is required.", "Database environment marker does not match APP_ENV.",
    "Database environment marker missing; seed/reset refused.", "Reset requires --confirm-reset (test/demo data only).",
    "Seed/reset requires APP_ENV=test or demo and a matching lastresort_test/demo database name.",
    "Database environment marker does not match APP_ENV; seed/reset refused.", "Use migrate, seed, reset or status."];
  console.error(error instanceof ConfigError || (error instanceof Error && safeMessages.includes(error.message))
    ? error.message : "Database command failed. Check connectivity and run db:migrate before seed/reset/status.");
  process.exitCode = 1;
});
