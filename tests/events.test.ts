import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../src/app/api/events/[eventId]/route.ts";
import { readEvent } from "../src/server/events.ts";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../src/server/database.ts", () => ({ getPool: () => ({ query }) }));

const eventRow = {
  id: "live-sessions-demo",
  name: "Live Sessions (Demo)",
  starts_at: new Date("2099-11-21T12:00:00.000Z"),
  venue: "Demo Hall",
  ticket_type: "General admission",
  price_minor: 0,
  sale_opens_at: new Date("2000-10-01T00:00:00.000Z"),
  sale_closes_at: new Date("2099-11-21T11:00:00.000Z"),
  capacity: 100,
  remaining: 40,
};

async function statusAt(now: string, remaining = eventRow.remaining) {
  const event = await readEvent(
    async () => ({ rows: [{ ...eventRow, remaining }] }),
    eventRow.id,
    new Date(now),
  );
  return event?.saleStatus;
}

function getEvent(eventId: string, url = `http://localhost/api/events/${eventId}`) {
  return GET(new Request(url), { params: Promise.resolve({ eventId }) });
}

describe("event sale status", () => {
  it("keeps the opening instant inclusive and closing instant exclusive", async () => {
    expect(await statusAt("2000-10-01T00:00:00.000Z")).toBe("open");
    expect(await statusAt("2099-11-21T11:00:00.000Z")).toBe("closed");
  });

  it("uses server time before opening and reports sold out only during the sale window", async () => {
    expect(await statusAt("2000-09-30T23:59:59.999Z", 0)).toBe("not_open");
    expect(await statusAt("2026-10-20T00:00:00.000Z", 0)).toBe("sold_out");
    expect(await statusAt("2099-11-21T11:00:00.000Z", 0)).toBe("closed");
  });
});

describe("GET /api/events/{eventId}", () => {
  beforeEach(() => { query.mockReset(); });

  it("returns event details with no-store caching", async () => {
    query.mockResolvedValue({ rows: [eventRow] });

    const response = await getEvent(eventRow.id);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      eventId: eventRow.id,
      name: eventRow.name,
      venue: eventRow.venue,
      ticketType: eventRow.ticket_type,
      saleStatus: "open",
      capacity: eventRow.capacity,
      remaining: eventRow.remaining,
    });
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0][1]).toEqual([eventRow.id]);
  });

  it("rejects malformed IDs and query parameters before database access", async () => {
    const malformed = await getEvent("Bad-ID");
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });

    const withQuery = await getEvent(eventRow.id, `http://localhost/api/events/${eventRow.id}?owner=private`);
    expect(withQuery.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it("returns not found without caching when the event does not exist", async () => {
    query.mockResolvedValue({ rows: [] });

    const response = await getEvent(eventRow.id);

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("returns a safe unavailable response when the database fails", async () => {
    query.mockRejectedValue(new Error("postgresql://private:secret@internal/database"));

    const response = await getEvent(eventRow.id);
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).not.toContain("secret");
    expect(body).not.toContain("postgresql://");
  });
});
