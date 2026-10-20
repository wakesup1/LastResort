import { describe, expect, it } from "vitest";
import { formatEventDate, isEventDetails } from "../src/app/_lib/event-details.ts";

const event = {
  eventId: "live-sessions-demo",
  name: "Live Sessions (Demo)",
  startsAt: "2026-11-21T12:00:00.000Z",
  venue: "Demo Hall",
  ticketType: "General admission",
  priceMinor: 0,
  saleOpensAt: "2026-10-01T00:00:00.000Z",
  saleClosesAt: "2026-11-21T11:00:00.000Z",
  saleStatus: "open",
  capacity: 100,
  remaining: 40,
};

describe("event presentation data", () => {
  it("accepts actual event fields and sold-out inventory without inventing availability", () => {
    expect(isEventDetails(event)).toBe(true);
    expect(isEventDetails({ ...event, remaining: 0, saleStatus: "sold_out" })).toBe(true);
  });

  it.each(["startsAt", "saleOpensAt", "saleClosesAt"])("rejects an invalid %s before the UI formats it", (field) => {
    expect(isEventDetails({ ...event, [field]: "not-a-date" })).toBe(false);
    expect(isEventDetails({ ...event, [field]: "2026-10-01T00:00:00" })).toBe(false);
  });

  it.each([-1, 101, 1.5, "40", null, Number.NaN])("rejects inventory outside the supported contract: %s", (remaining) => {
    expect(isEventDetails({ ...event, remaining })).toBe(false);
  });

  it("rejects impossible windows and non-free prices rather than displaying misleading booking details", () => {
    expect(isEventDetails({ ...event, saleClosesAt: event.saleOpensAt })).toBe(false);
    expect(isEventDetails({ ...event, saleClosesAt: "2027-01-01T00:00:00Z" })).toBe(false);
    expect(isEventDetails({ ...event, priceMinor: 100 })).toBe(false);
  });

  it("rejects missing display values and unknown sale statuses", () => {
    expect(isEventDetails({ ...event, name: " " })).toBe(false);
    expect(isEventDetails({ ...event, saleStatus: "available" })).toBe(false);
    expect(isEventDetails(null)).toBe(false);
  });

  it("uses Bangkok time for both the event and a date crossing midnight UTC", () => {
    expect(formatEventDate(event.startsAt)).toContain("7:00 PM GMT+7");
    const newYear = formatEventDate("2026-12-31T18:00:00Z");
    expect(newYear).toContain("Jan 1, 2027");
    expect(newYear).toContain("1:00 AM GMT+7");
  });
});
