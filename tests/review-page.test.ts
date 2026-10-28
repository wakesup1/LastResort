import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ReviewBooking from "../src/app/review/page.tsx";
import { useBooking } from "../src/app/_hooks/use-booking.ts";
import { useEventDetails, type EventLoadState } from "../src/app/_hooks/use-event-details.ts";
import { BOOKING_STORAGE_KEY, createBookingController } from "../src/app/_lib/booking.ts";

vi.mock("../src/app/_hooks/use-booking.ts", () => ({ useBooking: vi.fn() }));
vi.mock("../src/app/_hooks/use-event-details.ts", () => ({ useEventDetails: vi.fn() }));

const event = {
  eventId: "live-sessions-demo", name: "Live Sessions (Demo)", startsAt: "2026-11-21T12:00:00Z",
  venue: "Demo Hall", ticketType: "General admission", priceMinor: 0,
  saleOpensAt: "2026-10-01T00:00:00Z", saleClosesAt: "2026-11-21T11:00:00Z",
  saleStatus: "open", capacity: 100, remaining: 40,
} satisfies Extract<EventLoadState, { kind: "ready" }>["event"];
const confirm = vi.fn(async () => {});
const check = vi.fn(async () => {});
const refresh = vi.fn();
const unavailableStates = ["error", "not-found", "loading"] as const;
const outcomes = ["SOLD_OUT", "SALES_NOT_OPEN", "SALES_CLOSED", "NOT_FOUND"] as const;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useBooking).mockReturnValue({ booking: { kind: "ready" }, confirm, check });
  vi.mocked(useEventDetails).mockReturnValue({ state: { kind: "ready", event, freshness: "current" }, refresh });
});

describe("review page terminal outcomes (S3-01)", () => {
  describe.each(outcomes)("recovered %s", (code) => {
    it.each(unavailableStates)("keeps the resolved rejection and next action visible with event state %s", async (kind) => {
      const operationId = "7b013fc7-c29f-428e-98ea-04cbe234e917";
      const values = new Map([[BOOKING_STORAGE_KEY, JSON.stringify({ operationId, eventId: event.eventId, protocol: "idempotent-v1" })]]);
      const storage = {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
        removeItem: (key: string) => { values.delete(key); },
      };
      const send = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ eventId: event.eventId, outcome: { code } }));
      const controller = createBookingController(storage, send);
      expect(controller.restore()).toEqual({ kind: "unknown" });
      const booking = await controller.check();
      if (booking.kind !== "rejected") throw new Error("Expected a recovered terminal rejection.");
      expect(storage.getItem(BOOKING_STORAGE_KEY)).toBeNull();
      vi.mocked(useBooking).mockReturnValue({ booking, confirm, check });
      vi.mocked(useEventDetails).mockReturnValue({ state: { kind }, refresh });

      const html = renderToStaticMarkup(createElement(ReviewBooking));
      expect(html).toMatch(/<h1[^>]*>No ticket was reserved\.<\/h1>/);
      expect(html).toContain(booking.message);
      expect(html).toMatch(/<a[^>]*href="\/"[^>]*>Back to event/);
      expect(html).not.toContain('aria-label="One ticket summary"');
      expect(html).not.toContain("Confirm reservation");
      expect(html).not.toContain("Check booking result");
      expect(confirm).not.toHaveBeenCalled();
      expect(check).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledExactlyOnceWith(`/api/booking-operations/${operationId}`, expect.objectContaining({ method: "GET" }));
    });
  });

  it("includes the optional event summary alongside a known rejection when details are available", () => {
    vi.mocked(useBooking).mockReturnValue({ booking: { kind: "rejected", message: "Tickets sold out before confirmation. No ticket was reserved." }, confirm, check });
    const html = renderToStaticMarkup(createElement(ReviewBooking));
    expect(html).toContain("No ticket was reserved.");
    expect(html).toContain('aria-label="One ticket summary"');
    expect(html).toContain(event.name);
    expect(html).toMatch(/<a[^>]*href="\/"[^>]*>Back to event/);
    expect(html).not.toContain("Confirm reservation");
  });

  it.each(["error", "not-found"] as const)("does not infer a booking rejection from event state %s alone", (kind) => {
    vi.mocked(useEventDetails).mockReturnValue({ state: { kind }, refresh });
    const html = renderToStaticMarkup(createElement(ReviewBooking));
    expect(html).not.toContain("No ticket was reserved.");
    expect(html).toContain(kind === "error" ? "We couldn’t load this event." : "This event isn’t available.");
  });
});
