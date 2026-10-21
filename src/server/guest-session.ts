import { createHash, randomBytes, randomUUID } from "node:crypto";

export const GUEST_SESSION_COOKIE_NAME = "lastresort_guest";
export const GUEST_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

export type GuestSession = { ownerId: string };

type GuestSessionRow = { id: string };
type Query = (sql: string, values: string[]) => Promise<{ rows: GuestSessionRow[] }>;

type EstablishedGuestSession = {
  session: GuestSession;
  setCookie: string | null;
};

type CreatedGuestSession = {
  session: GuestSession;
  setCookie: string;
};

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function hashToken(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function readToken(cookieHeader: string | null) {
  if (!cookieHeader) return null;

  let token: string | null = null;
  for (const cookie of cookieHeader.split(";")) {
    const separator = cookie.indexOf("=");
    if (separator < 0 || cookie.slice(0, separator).trim() !== GUEST_SESSION_COOKIE_NAME) continue;
    if (token !== null) return null;

    const value = cookie.slice(separator + 1).trim();
    if (!TOKEN_PATTERN.test(value)) return null;
    token = value;
  }
  return token;
}

function serializeCookie(token: string, secure: boolean) {
  const attributes = [
    `${GUEST_SESSION_COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${GUEST_SESSION_TTL_SECONDS}`,
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

export async function resolveGuestSession(query: Query, cookieHeader: string | null): Promise<GuestSession | null> {
  const token = readToken(cookieHeader);
  if (!token) return null;

  const result = await query(
    `SELECT id
       FROM lastresort.guest_sessions
      WHERE token_hash = $1 AND expires_at > now()`,
    [hashToken(token)],
  );
  const row = result.rows[0];
  return row ? { ownerId: row.id } : null;
}

export async function createGuestSession(query: Query, secure = false): Promise<CreatedGuestSession> {
  const token = randomBytes(32).toString("base64url");
  if (!TOKEN_PATTERN.test(token)) throw new Error("Guest session token generator returned an invalid token.");
  const ownerId = randomUUID();

  const result = await query(
    `INSERT INTO lastresort.guest_sessions (id, token_hash, expires_at)
     VALUES ($1, $2, now() + $3::int * interval '1 second')
     RETURNING id`,
    [ownerId, hashToken(token), String(GUEST_SESSION_TTL_SECONDS)],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Guest session was not created.");

  return {
    session: { ownerId: row.id },
    setCookie: serializeCookie(token, secure),
  };
}

export async function ensureGuestSession(
  query: Query,
  cookieHeader: string | null,
  secure: boolean,
): Promise<EstablishedGuestSession> {
  const existing = await resolveGuestSession(query, cookieHeader);
  if (existing) return { session: existing, setCookie: null };
  return createGuestSession(query, secure);
}
