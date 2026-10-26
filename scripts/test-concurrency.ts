import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { Pool } from "pg";
import { assertDisposableDatabase, readConfig } from "../src/server/config.ts";
import { casePassed, CONCURRENCY_CASES, CONCURRENCY_SCENARIOS, CONCURRENCY_TEST_PATTERN, parseRuns, readTestCounts, runRounds, writeJson } from "./concurrency-evidence.ts";

const execute = promisify(execFile);
type Round = { round: number; status: "passed" | "failed"; tests: ReturnType<typeof readTestCounts>; evidenceComplete: boolean };

async function main() {
  const runs = parseRuns(process.argv.slice(2));
  const directory = join(process.cwd(), "test-results", "concurrency", `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`);
  const summary = {
    task: "S2-02", startedAt: new Date().toISOString(), finishedAt: null as string | null,
    revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    workingTreeDirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0,
    environment: { node: process.version, platform: process.platform, architecture: process.arch, postgres: null as string | null },
    workload: CONCURRENCY_CASES, plannedRounds: runs, rounds: [] as Round[],
    status: "running" as "running" | "passed" | "failed", failure: null as string | null,
  };
  const summaryPath = join(directory, "summary.json");
  await writeJson(summaryPath, summary);
  try {
    // Never fall back to DATABASE_URL or .env.local, which may point at the active demo.
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (!databaseUrl) throw new Error("preflight");
    const config = readConfig({ APP_ENV: "test", DATABASE_URL: databaseUrl });
    const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 3000, statement_timeout: 5000 });
    try {
      const info = await pool.query<{ name: string; version: number; version_text: string }>(
        "SELECT current_database() AS name, current_setting('server_version_num')::int AS version, current_setting('server_version') AS version_text",
      );
      const database = info.rows[0];
      if (!database || Math.floor(database.version / 10000) !== 17) throw new Error("preflight");
      assertDisposableDatabase(config, database.name);
      const marker = await pool.query<{ name: string }>("SELECT name FROM lastresort.environment WHERE id=1");
      if (!marker.rows[0]) throw new Error("preflight");
      assertDisposableDatabase(config, database.name, marker.rows[0].name);
      summary.environment.postgres = database.version_text;
    } finally { await pool.end(); }
    await writeJson(summaryPath, summary);

    summary.rounds = await runRounds(runs, async (round): Promise<Round> => {
      const roundDirectory = join(directory, `round-${String(round).padStart(2, "0")}`);
      let output = "";
      let processPassed = false;
      try {
        const result = await execute(process.execPath, [
          "node_modules/vitest/vitest.mjs", "run", "tests/database.integration.test.ts",
          "--testNamePattern", CONCURRENCY_TEST_PATTERN, "--reporter=./scripts/concurrency-json-reporter.ts", "--retry=0",
        ], {
          env: { ...process.env, APP_ENV: "test", DATABASE_URL: databaseUrl, LASTRESORT_CONCURRENCY_REPORT_DIR: roundDirectory },
          timeout: 90_000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8",
        });
        output = result.stdout;
        processPassed = true;
      } catch (error: unknown) {
        // Do not write child stderr/stdout or arbitrary error fields to logs/artifacts.
        if (typeof error === "object" && error !== null && "stdout" in error && typeof error.stdout === "string") output = error.stdout;
      }
      const tests = readTestCounts(output);
      let evidenceComplete = true;
      for (const scenario of CONCURRENCY_SCENARIOS) {
        try {
          const evidence: unknown = JSON.parse(await readFile(join(roundDirectory, `${scenario}.json`), "utf8"));
          if (!casePassed(evidence, scenario)) evidenceComplete = false;
        } catch { evidenceComplete = false; }
      }
      const status = processPassed && tests?.success && tests.passed === 2 && tests.failed === 0 && evidenceComplete ? "passed" : "failed";
      const result: Round = { round, status, tests, evidenceComplete };
      // Preserve completed rounds even if a later round is interrupted.
      summary.rounds.push(result);
      await writeJson(summaryPath, summary);
      console.log(`Concurrency round ${round}/${runs}: ${status}.`);
      return result;
    });
    summary.status = summary.rounds.length === runs && summary.rounds.every((round) => round.status === "passed") ? "passed" : "failed";
    if (summary.status === "failed") summary.failure = "A round failed, timed out or did not produce both verified case reports. No failed round is retried.";
  } catch {
    summary.status = "failed";
    summary.failure = "Preflight or report writing failed. Use a migrated, dedicated disposable PostgreSQL 17 TEST_DATABASE_URL with a matching test database name and test environment marker.";
  } finally {
    summary.finishedAt = new Date().toISOString();
    await writeJson(summaryPath, summary);
    console.log(`Concurrency evidence: ${relative(process.cwd(), summaryPath)}`);
  }
  if (summary.status !== "passed") process.exitCode = 1;
}

main().catch(() => {
  console.error("Concurrency verification could not run. Use --runs <1-20> and a dedicated, migrated PostgreSQL 17 TEST_DATABASE_URL. No connection details were logged.");
  process.exitCode = 1;
});
