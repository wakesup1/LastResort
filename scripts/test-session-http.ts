import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { assertDisposableDatabase, readConfig } from "../src/server/config.ts";

type HttpResult = { status: number; headers: IncomingHttpHeaders; body: string };

async function getAvailablePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not select an HTTP test port.");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}

function postSession(port: number, origin: string, body?: string) {
  return new Promise<HttpResult>((resolve, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port,
      path: "/api/session",
      method: "POST",
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: origin,
        ...(body === undefined
          ? { "Content-Length": "0" }
          : { "Content-Length": String(Buffer.byteLength(body)), "Content-Type": "application/json" }),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.setTimeout(5000, () => request.destroy(new Error("Session HTTP test timed out.")));
    request.on("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

async function waitForServer(child: ChildProcess, port: number) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("The production server exited before becoming ready.");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (response.status === 200 || response.status === 503) return;
    } catch {}
    await delay(200);
  }
  throw new Error("The production server did not become ready.");
}

async function stopServer(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    delay(5000),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("Set TEST_DATABASE_URL to a dedicated disposable PostgreSQL 17 test database.");

const config = readConfig({ APP_ENV: "test", DATABASE_URL: databaseUrl });
const pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 3000 });
let server: ChildProcess | undefined;
let createdTokenHash: string | undefined;

try {
  const databaseState = await pool.query<{ name: string }>("SELECT current_database() AS name");
  const databaseName = databaseState.rows[0]?.name;
  if (!databaseName) throw new Error("Could not verify the test database name.");
  assertDisposableDatabase(config, databaseName);
  const markerState = await pool.query<{ name: string }>("SELECT name FROM lastresort.environment WHERE id = 1");
  const marker = markerState.rows[0]?.name;
  if (!marker) throw new Error("The test database must be migrated and have an environment marker.");
  assertDisposableDatabase(config, databaseName, marker);

  const port = await getAvailablePort();
  server = spawn(process.execPath, [
    "node_modules/next/dist/bin/next",
    "start",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(port),
  ], {
    env: {
      ...process.env,
      APP_ENV: "test",
      APP_ORIGIN: "",
      DATABASE_URL: databaseUrl,
      NEXT_TELEMETRY_DISABLED: "1",
      NODE_ENV: "production",
    },
    stdio: "ignore",
  });

  await waitForServer(server, port);
  const origin = `http://127.0.0.1:${port}`;
  const accepted = await postSession(port, origin);
  assert.equal(accepted.status, 204, `Expected an empty same-origin POST to succeed; received ${accepted.status}: ${accepted.body}`);
  assert.equal(accepted.body, "");
  const cookie = Array.isArray(accepted.headers["set-cookie"])
    ? accepted.headers["set-cookie"][0]
    : accepted.headers["set-cookie"];
  assert.ok(cookie, "Expected the successful request to set the guest session cookie.");
  const token = cookie.split(";", 1)[0]?.split("=", 2)[1];
  assert.ok(token, "Expected the guest session cookie to contain a token.");
  createdTokenHash = createHash("sha256").update(token, "utf8").digest("hex");

  const rejectedBody = await postSession(port, origin, "{}");
  assert.equal(rejectedBody.status, 400, `Expected a nonempty body to be rejected: ${rejectedBody.body}`);
  assert.match(rejectedBody.body, /INVALID_REQUEST/);

  const rejectedOrigin = await postSession(port, "http://attacker.test");
  assert.equal(rejectedOrigin.status, 403, `Expected a cross-origin request to be rejected: ${rejectedOrigin.body}`);
  assert.match(rejectedOrigin.body, /ORIGIN_FORBIDDEN/);

  process.stdout.write("Production-server session HTTP checks passed.\n");
} finally {
  if (createdTokenHash) {
    await pool.query("DELETE FROM lastresort.guest_sessions WHERE token_hash = $1", [createdTokenHash]).catch(() => {});
  }
  if (server) await stopServer(server);
  await pool.end();
}
