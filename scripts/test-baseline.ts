import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { Pool } from "pg";
import { isReservation } from "../src/app/_lib/booking.ts";
import { assertDisposableDatabase, readConfig } from "../src/server/config.ts";
import { writeJson } from "./concurrency-evidence.ts";
import { inventoryMatches, latency, metrics, parseBaselineArgs, readBookingDiagnostic, runWorkers, type Attempt, type Inventory } from "./baseline-metrics.ts";

const execute = promisify(execFile);
const REQUESTS = 200;
const CAPACITY = 100;
const TIMEOUT_MS = 10000;
const SAMPLE_DELAY_MS = 100;
type Worker = { cookie: string; owner: string };
type Activity = { connections: number; active: number; lockWaiting: number };
type Case = {
  concurrency: number; status: "running" | "passed" | "failed"; phase: string;
  warmupRequests: number; warmupAttempts: Attempt[]; warmupInventory: Inventory | null; peakInFlight: number; attempts: Attempt[];
  metrics: ReturnType<typeof metrics> | null;
  serverLatency: ReturnType<typeof latency> | null;
  activity: (Activity & { offsetMs: number })[];
  monitoringFailed: boolean; inventory: Inventory | null; inventoryVerified: boolean; ownershipVerified: boolean;
};

async function availablePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No loopback port.");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function stopServer(child: ChildProcess | undefined) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await new Promise<void>((resolve) => {
    child.once("exit", () => { if (timer) clearTimeout(timer); resolve(); });
    timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.kill("SIGTERM");
  });
}

async function main() {
  const levels = parseBaselineArgs(process.argv.slice(2));
  const abort = new AbortController();
  const interrupt = () => abort.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const directory = join(process.cwd(), "test-results", "baseline", `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`);
  const summaryPath = join(directory, "summary.json");
  const report = {
    task: "S3-02", revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    workingTreeDirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0,
    runnerSha256: createHash("sha256").update(await readFile(new URL(import.meta.url))).update(await readFile(new URL("./baseline-metrics.ts", import.meta.url))).digest("hex"),
    startedAt: new Date().toISOString(), finishedAt: null as string | null,
    status: "running" as "running" | "passed" | "failed", phase: "preflight", interrupted: false,
    buildFailure: null as "security_advisory" | "build_failed" | "interrupted" | null,
    environment: { node: process.version, platform: process.platform, architecture: process.arch, cpus: (await import("node:os")).availableParallelism(), postgres: null as string | null, databaseLocation: "unknown", buildId: null as string | null },
    workload: { model: "bounded closed-loop; no retries", endpoint: "POST /api/reservations", capacity: CAPACITY, requestsPerLevel: REQUESTS, concurrencyLevels: levels, timeoutMs: TIMEOUT_MS, applicationInstances: 1, applicationPoolMax: 5, monitorConnections: 1, samplingDelayMs: SAMPLE_DELAY_MS, sessions: "one pre-established guest per worker, outside measurement", warmup: "one successful booking per worker on a separate event before each level" },
    cases: [] as Case[], cleanupCompleted: false,
  };
  await writeJson(summaryPath, report);
  let pool: Pool | undefined;
  let server: ChildProcess | undefined;
  let fixturesAllowed = false;
  let uncertainSessionSetup = false;
  const eventIds: string[] = [];
  const tokenHashes: string[] = [];
  const diagnostics = new Map<string, number>();
  const requestIds = new Map<Attempt, string>();
  const receivedOwners = new Map<string, string>();
  try {
    // An explicit test URL is mandatory; the active demo's configuration is never used.
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (!databaseUrl) throw new Error("Dedicated TEST_DATABASE_URL required.");
    const config = readConfig({ APP_ENV: "test", DATABASE_URL: databaseUrl });
    const url = new URL(databaseUrl);
    if (url.hostname.includes("-pooler")) throw new Error("Use the direct test database connection.");
    report.environment.databaseLocation = ["localhost", "127.0.0.1", "::1"].includes(url.hostname) ? "local" : "remote";
    const database = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 10000, application_name: "lastresort-baseline-observer" });
    pool = database;
    const info = await database.query<{ name: string; version: number; version_text: string }>("SELECT current_database() AS name, current_setting('server_version_num')::int AS version, current_setting('server_version') AS version_text");
    const state = info.rows[0];
    if (!state || Math.floor(state.version / 10000) !== 17) throw new Error("PostgreSQL 17 required.");
    assertDisposableDatabase(config, state.name);
    const marker = await database.query<{ name: string }>("SELECT name FROM lastresort.environment WHERE id=1");
    if (!marker.rows[0]) throw new Error("Missing environment marker.");
    assertDisposableDatabase(config, state.name, marker.rows[0].name);
    const other = await database.query<{ count: number }>("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND application_name='lastresort'");
    if (other.rows[0]?.count !== 0) throw new Error("Another application is using this database.");
    report.environment.postgres = state.version_text;
    fixturesAllowed = true;

    const env: NodeJS.ProcessEnv = { ...process.env, APP_ENV: "test", DATABASE_URL: databaseUrl, APP_ORIGIN: "", NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" };
    report.phase = "build";
    await writeJson(summaryPath, report);
    // Build once per invocation, excluding build/startup from all measured durations.
    // A failed build ends this run and its evidence; it is never silently retried.
    try {
      await execute(process.execPath, ["node_modules/next/dist/bin/next", "build"], { env, signal: abort.signal, timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
    } catch (error: unknown) {
      // Classify a known build reminder without retaining arbitrary child output.
      const output = typeof error === "object" && error !== null
        ? ("stdout" in error && typeof error.stdout === "string" ? error.stdout : "") + ("stderr" in error && typeof error.stderr === "string" ? error.stderr : "")
        : "";
      report.buildFailure = abort.signal.aborted ? "interrupted" : /SecurityFatalError|known security vulnerability/.test(output) ? "security_advisory" : "build_failed";
      throw new Error("Build did not complete.");
    }
    report.environment.buildId = (await readFile(".next/BUILD_ID", "utf8")).trim();
    const port = await availablePort();
    const origin = `http://127.0.0.1:${port}`;
    report.phase = "server-start";
    const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], { env, stdio: ["ignore", "pipe", "ignore"] });
    server = child;
    let spawnFailed = false;
    child.once("error", () => { spawnFailed = true; });
    let pending = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      if (pending.length > 65536) pending = "";
      for (const line of lines) {
        if (line.length > 16384) continue;
        const diagnostic = readBookingDiagnostic(line);
        if (diagnostic) diagnostics.set(diagnostic.requestId, diagnostic.durationMs);
      }
    });
    let ready = false;
    const deadline = performance.now() + 30000;
    while (!ready && performance.now() < deadline && !abort.signal.aborted) {
      if (spawnFailed || child.exitCode !== null || child.signalCode !== null) throw new Error("Server exited.");
      try {
        const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(2000)]) });
        ready = response.status === 200;
        await response.arrayBuffer();
      } catch {}
      if (!ready) await delay(200, undefined, { signal: abort.signal });
    }
    if (!ready) throw new Error("Server not ready.");

    async function fixture(capacity: number) {
      const id = `baseline-${randomUUID()}`;
      eventIds.push(id);
      await database.query(`INSERT INTO lastresort.events
        (id,name,starts_at,venue,ticket_type,price_minor,sale_opens_at,sale_closes_at,capacity,remaining)
        VALUES ($1,'Baseline fixture',clock_timestamp()+interval '2 days','Test Hall','General admission',0,
                clock_timestamp()-interval '1 day',clock_timestamp()+interval '1 day',$2,$2)`, [id, capacity]);
      return id;
    }

    async function session(): Promise<Worker> {
      try {
        const response = await fetch(`${origin}/api/session`, { method: "POST", headers: { Origin: origin }, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(TIMEOUT_MS)]) });
        const cookie = response.headers.get("set-cookie")?.split(";")[0];
        if (response.status !== 204 || !cookie || !/^lastresort_guest=[A-Za-z0-9_-]{43}$/.test(cookie)) throw new Error("Session unavailable.");
        const hash = createHash("sha256").update(cookie.slice(cookie.indexOf("=") + 1)).digest("hex");
        tokenHashes.push(hash);
        const result = await database.query<{ id: string }>("SELECT id FROM lastresort.guest_sessions WHERE token_hash=$1", [hash]);
        if (!result.rows[0]) throw new Error("Session missing.");
        return { cookie, owner: result.rows[0].id };
      } catch { uncertainSessionSetup = true; throw new Error("Session setup failed."); }
    }

    async function book(eventId: string, worker: Worker, index: number, workerIndex: number, attempts: Attempt[]) {
      const startedAt = performance.now();
      let status: number | null = null;
      let outcome: Attempt["outcome"] = "unexpected";
      let requestId: string | null = null;
      try {
        const response = await fetch(`${origin}/api/reservations`, {
          method: "POST", headers: { Origin: origin, Cookie: worker.cookie, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
          body: JSON.stringify({ eventId, quantity: 1 }), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(TIMEOUT_MS)]),
        });
        status = response.status;
        requestId = response.headers.get("x-request-id");
        const body: unknown = await response.json();
        if (response.headers.get("cache-control") === "no-store") {
          if (status === 201 && isReservation(body) && body.event.eventId === eventId && !receivedOwners.has(body.reference)) {
            receivedOwners.set(body.reference, worker.owner);
            outcome = "confirmed";
          } else if (status === 409 && typeof body === "object" && body !== null && "error" in body && typeof body.error === "object" && body.error !== null && "code" in body.error && body.error.code === "SOLD_OUT") outcome = "sold_out";
        }
      } catch (error: unknown) { outcome = error instanceof Error && error.name === "TimeoutError" ? "timeout" : "transport_error"; }
      const attempt: Attempt = { index, worker: workerIndex, durationMs: performance.now() - startedAt, status, outcome };
      attempts.push(attempt);
      if (requestId) requestIds.set(attempt, requestId);
      return attempt;
    }

    async function snapshot(eventId: string): Promise<Inventory> {
      const result = await database.query<Inventory>(`SELECT capacity,remaining,
        (SELECT count(*)::int FROM lastresort.reservations WHERE event_id=e.id) AS confirmed,
        (SELECT count(*)::int FROM lastresort.booking_operations WHERE event_id=e.id) AS operations,
        (SELECT count(*)::int FROM lastresort.booking_operations WHERE event_id=e.id AND response->>'code'='SOLD_OUT') AS "soldOut",
        (SELECT count(*)::int FROM lastresort.booking_operations WHERE event_id=e.id AND response IS NULL) AS incomplete
        FROM lastresort.events e WHERE id=$1`, [eventId]);
      const row = result.rows[0];
      if (!row) throw new Error("Fixture missing.");
      return row;
    }

    for (const concurrency of levels) {
      if (abort.signal.aborted) throw new Error("Interrupted.");
      const evidence: Case = { concurrency, status: "running", phase: "setup", warmupRequests: concurrency, warmupAttempts: [], warmupInventory: null, peakInFlight: 0, attempts: [], metrics: null, serverLatency: null, activity: [], monitoringFailed: false, inventory: null, inventoryVerified: false, ownershipVerified: false };
      report.cases.push(evidence);
      report.phase = `concurrency-${concurrency}`;
      await writeJson(summaryPath, report);
      const workers: Worker[] = [];
      for (let worker = 0; worker < concurrency; worker += 1) workers.push(await session());
      evidence.phase = "warmup";
      const warmupId = await fixture(concurrency);
      const warmup = evidence.warmupAttempts;
      await runWorkers(concurrency, concurrency, (index, worker) => book(warmupId, workers[worker], index, worker, warmup), () => abort.signal.aborted);
      evidence.warmupInventory = await snapshot(warmupId);
      if (!inventoryMatches(evidence.warmupInventory, warmup, concurrency, concurrency)) throw new Error("Warmup failed.");
      const eventId = await fixture(CAPACITY);
      evidence.phase = "measurement";
      console.log(`Baseline: ${REQUESTS} requests, capacity ${CAPACITY}, HTTP concurrency ${concurrency}.`);
      await writeJson(summaryPath, report);
      const startedAt = performance.now();
      let stopMonitoring = false;
      const monitoring = (async () => {
        while (!stopMonitoring && !abort.signal.aborted) {
          try {
            const result = await database.query<Activity>(`SELECT count(*)::int AS connections,
              count(*) FILTER (WHERE state='active')::int AS active,
              count(*) FILTER (WHERE wait_event_type='Lock')::int AS "lockWaiting"
              FROM pg_stat_activity WHERE datname=current_database() AND application_name='lastresort'`);
            if (result.rows[0] && !stopMonitoring) evidence.activity.push({ offsetMs: performance.now() - startedAt, ...result.rows[0] });
          } catch { evidence.monitoringFailed = true; break; }
          await delay(SAMPLE_DELAY_MS);
        }
      })();
      let durationMs: number;
      try {
        const result = await runWorkers(REQUESTS, concurrency, (index, worker) => book(eventId, workers[worker], index, worker, evidence.attempts), () => abort.signal.aborted);
        durationMs = performance.now() - startedAt;
        evidence.peakInFlight = result.peakInFlight;
      } finally { stopMonitoring = true; await monitoring; }
      evidence.attempts.sort((a, b) => a.index - b.index);
      evidence.metrics = metrics(evidence.attempts, durationMs);
      // Late/unknown results must settle before querying inventory or deleting fixtures.
      if (evidence.metrics.errorRate !== 0 || abort.signal.aborted) await stopServer(server);
      evidence.phase = "post-load-inventory";
      evidence.inventory = await snapshot(eventId);
      evidence.inventoryVerified = inventoryMatches(evidence.inventory, evidence.attempts, CAPACITY, REQUESTS);
      const owners = await database.query<{ reference: string; owner: string }>("SELECT reference,guest_session_id AS owner FROM lastresort.reservations WHERE event_id=$1", [eventId]);
      evidence.ownershipVerified = owners.rows.length === evidence.metrics.counts.confirmed && owners.rows.every((row) => receivedOwners.get(row.reference) === row.owner);
      // Allow stdout diagnostics to arrive after response consumption; exclude this wait from timing.
      const diagnosticDeadline = performance.now() + 1000;
      while (evidence.attempts.some((attempt) => !diagnostics.has(requestIds.get(attempt) ?? "")) && performance.now() < diagnosticDeadline && !abort.signal.aborted) await delay(20);
      evidence.serverLatency = latency(evidence.attempts.flatMap((attempt) => {
        const value = diagnostics.get(requestIds.get(attempt) ?? "");
        return value === undefined ? [] : [value];
      }));
      evidence.status = evidence.inventoryVerified && evidence.ownershipVerified && !evidence.monitoringFailed && evidence.metrics.errorRate === 0 && evidence.serverLatency.samples === REQUESTS && !abort.signal.aborted ? "passed" : "failed";
      evidence.phase = "complete";
      await writeJson(join(directory, `concurrency-${concurrency}.json`), evidence);
      await writeJson(summaryPath, report);
      console.log(`Baseline concurrency ${concurrency}: ${evidence.status}; confirmed ${evidence.metrics.counts.confirmed}, sold out ${evidence.metrics.counts.sold_out}, technical errors ${evidence.metrics.counts.timeout + evidence.metrics.counts.transport_error + evidence.metrics.counts.unexpected}.`);
      if (evidence.status === "failed") break;
    }
    report.status = report.cases.length === levels.length && report.cases.every((item) => item.status === "passed") ? "passed" : "failed";
    report.phase = "complete";
  } catch {
    report.status = "failed";
    for (const evidence of report.cases) if (evidence.status === "running") evidence.status = "failed";
    console.error(`Baseline stopped during ${report.phase}${report.buildFailure ? ` (${report.buildFailure})` : ""}. Retained partial data; no failed workload was retried.`);
  } finally {
    report.interrupted = abort.signal.aborted;
    try {
      await stopServer(server);
      if (pool && fixturesAllowed) {
        await pool.query("DELETE FROM lastresort.booking_operations WHERE event_id=ANY($1::text[])", [eventIds]);
        await pool.query("DELETE FROM lastresort.reservations WHERE event_id=ANY($1::text[])", [eventIds]);
        await pool.query("DELETE FROM lastresort.events WHERE id=ANY($1::text[])", [eventIds]);
        await pool.query("DELETE FROM lastresort.guest_sessions WHERE token_hash=ANY($1::text[])", [tokenHashes]);
      }
      report.cleanupCompleted = !uncertainSessionSetup;
    } catch { report.status = "failed"; report.cleanupCompleted = false; }
    if (pool) await pool.end().catch(() => { report.status = "failed"; report.cleanupCompleted = false; });
    report.finishedAt = new Date().toISOString();
    await writeJson(summaryPath, report);
    console.log(`Baseline evidence: ${relative(process.cwd(), summaryPath)}`);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
  if (report.status !== "passed") process.exitCode = 1;
}

main().catch(() => {
  console.error("Baseline could not retain evidence. Use a direct, migrated, dedicated disposable PostgreSQL 17 TEST_DATABASE_URL and bounded --concurrency values. No connection details were logged.");
  process.exitCode = 1;
});
