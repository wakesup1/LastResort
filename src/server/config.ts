export type AppEnvironment = "demo" | "test" | "production";
export type Config = { appEnv: AppEnvironment; databaseUrl: string; appOrigin: string | null };

export class ConfigError extends Error {}

export function readConfig(env: Record<string, string | undefined> = process.env): Config {
  const missing = ["APP_ENV", "DATABASE_URL"].filter((key) => !env[key]?.trim());
  if (missing.length) throw new ConfigError(`Missing configuration: ${missing.join(", ")}`);
  if (!["demo", "test", "production"].includes(env.APP_ENV!)) {
    throw new ConfigError("Invalid configuration: APP_ENV (use demo, test or production)");
  }
  try {
    const url = new URL(env.DATABASE_URL!);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || url.pathname.length < 2) {
      throw new Error();
    }
  } catch {
    throw new ConfigError("Invalid configuration: DATABASE_URL");
  }

  const appOrigin = env.APP_ORIGIN?.trim() || null;
  if (appOrigin) {
    try {
      const url = new URL(appOrigin);
      if (!["http:", "https:"].includes(url.protocol) || url.origin !== appOrigin) throw new Error();
    } catch {
      throw new ConfigError("Invalid configuration: APP_ORIGIN");
    }
  }

  return { appEnv: env.APP_ENV as AppEnvironment, databaseUrl: env.DATABASE_URL!, appOrigin };
}

export function assertDisposableDatabase(config: Config, database: string, marker?: string) {
  if (config.appEnv === "production" || !new RegExp(`^lastresort_${config.appEnv}(?:_[a-z0-9_]+)?$`).test(database)) {
    throw new Error("Seed/reset requires APP_ENV=test or demo and a matching lastresort_test/demo database name.");
  }
  if (marker !== undefined && marker !== config.appEnv) {
    throw new Error("Database environment marker does not match APP_ENV; seed/reset refused.");
  }
}
