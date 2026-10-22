import { Pool } from "pg";
import { readConfig } from "./config.ts";
import { reportDatabaseUnavailable } from "./diagnostics.ts";

const globalDatabase = globalThis as typeof globalThis & { lastResortPool?: Pool };

export function getPool() {
  if (!globalDatabase.lastResortPool) {
    globalDatabase.lastResortPool = new Pool({
      connectionString: readConfig().databaseUrl,
      max: 5,
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 10000,
      statement_timeout: 5000,
      application_name: "lastresort",
    });
    // Never log a driver's raw error; it may include connection details.
    globalDatabase.lastResortPool.on("error", reportDatabaseUnavailable);
  }
  return globalDatabase.lastResortPool;
}
