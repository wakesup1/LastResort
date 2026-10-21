import { describe, expect, it } from "vitest";
import { assertDisposableDatabase, readConfig } from "../src/server/config.ts";
import { checkHealth } from "../src/server/health.ts";

describe("configuration", () => {
  it("names missing values", () => {
    expect(() => readConfig({})).toThrow("Missing configuration: APP_ENV, DATABASE_URL");
    expect(() => readConfig({ APP_ENV: "demo" })).toThrow("DATABASE_URL");
  });
  it("does not expose an invalid credential", () => {
    expect(() => readConfig({ APP_ENV: "demo", DATABASE_URL: "secret-password" })).toThrow(/^Invalid configuration: DATABASE_URL$/);
  });
  it("rejects invalid environment", () => {
    expect(() => readConfig({ APP_ENV: "typo", DATABASE_URL: "postgresql://localhost/lastresort_demo" })).toThrow("APP_ENV");
  });
  it("accepts a canonical application origin and rejects paths", () => {
    const config = { APP_ENV: "demo", DATABASE_URL: "postgresql://localhost/lastresort_demo" };
    expect(readConfig({ ...config, APP_ORIGIN: "https://tickets.example" }).appOrigin).toBe("https://tickets.example");
    expect(() => readConfig({ ...config, APP_ORIGIN: "https://tickets.example/path" })).toThrow("Invalid configuration: APP_ORIGIN");
  });
});

describe("disposable data guard", () => {
  const config = { appEnv: "demo" as const, databaseUrl: "postgresql://localhost/lastresort_demo", appOrigin: null };
  it("allows matching demo and test databases", () => {
    expect(() => assertDisposableDatabase(config, "lastresort_demo", "demo")).not.toThrow();
    expect(() => assertDisposableDatabase({ ...config, appEnv: "test" }, "lastresort_test_ci", "test")).not.toThrow();
  });
  it.each(["postgres", "customer_data", "lastresort_test", "lastresort_demo_production-invalid"])("rejects %s", (name) => {
    expect(() => assertDisposableDatabase(config, name, "demo")).toThrow();
  });
  it("rejects production even with a disposable name", () => {
    expect(() => assertDisposableDatabase({ ...config, appEnv: "production" }, "lastresort_demo", "demo")).toThrow();
  });
  it("rejects mismatching persisted marker", () => {
    expect(() => assertDisposableDatabase(config, "lastresort_demo", "production")).toThrow();
  });
});

describe("health", () => {
  it("returns ready only after a successful database query", async () => {
    expect(await checkHealth(async () => ({ rows: [] }))).toEqual({ status: 200, body: { status: "ok", database: "ready" } });
  });
  it("returns 503 without connection details on failure", async () => {
    expect(await checkHealth(async () => { throw new Error("secret-password"); })).toEqual({ status: 503, body: { status: "unavailable", database: "unavailable" } });
  });
});
