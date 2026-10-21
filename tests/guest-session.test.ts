import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../src/app/api/session/route.ts";
import {
  createGuestSession,
  GUEST_SESSION_COOKIE_NAME,
  GUEST_SESSION_TTL_SECONDS,
  resolveGuestSession,
} from "../src/server/guest-session.ts";
import { getExpectedOrigin, hasRequestBody, isSameOriginRequest } from "../src/server/http.ts";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../src/server/database.ts", () => ({ getPool: () => ({ query }) }));

const OWNER_ID = "65b95c90-6a7f-4378-ad84-3aacd97cc593";
const TOKEN = "A".repeat(43);

function sessionRequest(options: { url?: string; origin?: string; cookie?: string; body?: string } = {}) {
  const headers = new Headers();
  if (options.origin !== undefined) headers.set("Origin", options.origin);
  if (options.cookie !== undefined) headers.set("Cookie", options.cookie);
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  return new Request(options.url ?? "https://example.test/api/session", { method: "POST", headers, body: options.body });
}

describe("guest session helpers", () => {
  it("stores a one-way token hash and returns an HttpOnly browser cookie", async () => {
    const query = vi.fn(async (_sql: string, values: string[]) => ({ rows: [{ id: values[0] }] }));
    const result = await createGuestSession(query, true);
    const token = result.setCookie.split(";")[0]?.split("=")[1] ?? "";
    const values = query.mock.calls[0]?.[1] ?? [];

    expect(query.mock.calls[0]?.[0]).toContain("INSERT INTO lastresort.guest_sessions");
    expect(values[0]).toBe(result.session.ownerId);
    expect(values[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(values[1]).toBe(createHash("sha256").update(token, "utf8").digest("hex"));
    expect(values[1]).not.toBe(token);
    expect(values[2]).toBe(String(GUEST_SESSION_TTL_SECONDS));
    expect(result.setCookie).toBe(`${GUEST_SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${GUEST_SESSION_TTL_SECONDS}; Secure`);
  });

  it("resolves an owner only from a matching, unexpired server-side session", async () => {
    const query = vi.fn(async (_sql: string, _values: string[]) => ({ rows: [{ id: OWNER_ID }] }));
    const result = await resolveGuestSession(query, `${GUEST_SESSION_COOKIE_NAME}=${TOKEN}`);

    expect(result).toEqual({ ownerId: OWNER_ID });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("token_hash = $1 AND expires_at > now()"),
      [createHash("sha256").update(TOKEN, "utf8").digest("hex")],
    );
    expect(query.mock.calls[0]?.[1]).not.toContain(TOKEN);
  });

  it("ignores malformed and duplicate session cookies without querying the database", async () => {
    const query = vi.fn(async () => ({ rows: [{ id: OWNER_ID }] }));

    expect(await resolveGuestSession(query, `${GUEST_SESSION_COOKIE_NAME}=forged`)).toBeNull();
    expect(await resolveGuestSession(query, `${GUEST_SESSION_COOKIE_NAME}=${TOKEN}; ${GUEST_SESSION_COOKIE_NAME}=${TOKEN}`)).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
});

describe("HTTP request checks", () => {
  it("uses the direct Host header and ignores forwarded host headers", () => {
    const request = new Request("http://localhost:3108/api/session", {
      method: "POST",
      headers: {
        Host: "127.0.0.1:3108",
        Origin: "http://127.0.0.1:3108",
        "X-Forwarded-Host": "attacker.test",
      },
    });

    expect(getExpectedOrigin(request)).toBe("http://127.0.0.1:3108");
    expect(isSameOriginRequest(request)).toBe(true);
    expect(isSameOriginRequest(new Request(request.url, {
      method: "POST",
      headers: { Host: "127.0.0.1:3108", Origin: "http://attacker.test", "X-Forwarded-Host": "attacker.test" },
    }))).toBe(false);
  });

  it("uses the configured public origin when a proxy changes the internal host", () => {
    const request = new Request("http://next-internal:3000/api/session", {
      method: "POST",
      headers: { Host: "next-internal:3000", Origin: "https://tickets.example", "X-Forwarded-Host": "attacker.test" },
    });

    expect(isSameOriginRequest(request, "https://tickets.example")).toBe(true);
    expect(isSameOriginRequest(request, "https://other.example")).toBe(false);
  });

  it("accepts a zero-byte stream and rejects a streamed body without buffering it all", async () => {
    const emptyBody = new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
    const bodyRequest = (body: ReadableStream<Uint8Array>) => {
      const init: RequestInit & { duplex: "half" } = {
        method: "POST",
        headers: { Origin: "https://example.test", "Content-Length": "0" },
        body,
        duplex: "half",
      };
      return new Request("https://example.test/api/session", init);
    };

    expect(await hasRequestBody(bodyRequest(emptyBody))).toBe(false);

    const nonemptyBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });
    expect(await hasRequestBody(bodyRequest(nonemptyBody))).toBe(true);
  });
});

describe("POST /api/session", () => {
  beforeEach(() => { query.mockReset(); });

  it("creates a session for a same-origin HTTPS request without returning JSON", async () => {
    query.mockResolvedValue({ rows: [{ id: OWNER_ID }] });
    const response = await POST(sessionRequest({ origin: "https://example.test" }));

    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toMatch(/^lastresort_guest=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure$/);
    expect(await response.text()).toBe("");
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain("INSERT INTO lastresort.guest_sessions");
  });

  it("keeps the existing owner without rotating a valid cookie", async () => {
    query.mockResolvedValue({ rows: [{ id: OWNER_ID }] });
    const response = await POST(sessionRequest({
      origin: "https://example.test",
      cookie: `${GUEST_SESSION_COOKIE_NAME}=${TOKEN}`,
    }));

    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain("token_hash = $1");
  });

  it.each([
    { label: "missing Origin", options: {} },
    { label: "cross-origin Origin", options: { origin: "https://attacker.test" } },
  ])("rejects $label before database access", async ({ options }) => {
    const response = await POST(sessionRequest(options));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: "ORIGIN_FORBIDDEN", message: "This endpoint accepts same-origin requests only." },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects unsupported query parameters before database access", async () => {
    const response = await POST(sessionRequest({
      url: "https://example.test/api/session?owner=forged",
      origin: "https://example.test",
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "INVALID_REQUEST", message: "This endpoint does not accept query parameters." },
    });
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects client-supplied owner data before database access", async () => {
    const response = await POST(sessionRequest({
      origin: "https://example.test",
      body: JSON.stringify({ ownerId: OWNER_ID, sessionToken: TOKEN }),
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "INVALID_REQUEST", message: "This endpoint does not accept a request body." },
    });
    expect(query).not.toHaveBeenCalled();
  });

  it("returns a safe unavailable response when session storage fails", async () => {
    query.mockRejectedValue(new Error("postgresql://private:secret@database"));
    const response = await POST(sessionRequest({ origin: "https://example.test" }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: "SERVICE_UNAVAILABLE", message: "The service is temporarily unavailable." },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
