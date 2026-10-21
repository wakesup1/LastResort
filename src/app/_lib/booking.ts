import type { Reservation } from "../../server/reservations.ts";

export type { Reservation };
export const BOOKING_STORAGE_KEY = "lastresort.booking";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type BookingState =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "pending" }
  | { kind: "unknown" }
  | { kind: "blocked" }
  | { kind: "rejected"; message: string }
  | { kind: "confirmed"; reference: string };

export function isReservation(value: unknown): value is Reservation {
  if (typeof value !== "object" || value === null || !("event" in value)) return false;
  const event = value.event;
  return "reference" in value && typeof value.reference === "string" && UUID_PATTERN.test(value.reference) &&
    "status" in value && value.status === "confirmed" && "quantity" in value && value.quantity === 1 &&
    "createdAt" in value && typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt)) &&
    typeof event === "object" && event !== null &&
    "eventId" in event && typeof event.eventId === "string" && event.eventId.length > 0 &&
    "name" in event && typeof event.name === "string" && event.name.length > 0 &&
    "venue" in event && typeof event.venue === "string" && event.venue.length > 0 &&
    "ticketType" in event && typeof event.ticketType === "string" && event.ticketType.length > 0 &&
    "startsAt" in event && typeof event.startsAt === "string" && Number.isFinite(Date.parse(event.startsAt));
}

const rejectionMessages: Record<string, string> = {
  SALES_NOT_OPEN: "Sales have not opened yet. No ticket was reserved.",
  SALES_CLOSED: "Sales have closed. No ticket was reserved.",
  SOLD_OUT: "Tickets sold out before confirmation. No ticket was reserved.",
  SESSION_REQUIRED: "Your browser session has expired. No ticket was reserved. Try confirming again.",
  NOT_FOUND: "This event is unavailable. No ticket was reserved.",
  INVALID_REQUEST: "The booking request was rejected. No ticket was reserved.",
  ORIGIN_FORBIDDEN: "The booking request was rejected. No ticket was reserved.",
};

// This browser guard is not server idempotency. An uncertain POST is never retried.
export function createBookingController(storage: Pick<Storage, "getItem" | "setItem" | "removeItem">, send: typeof fetch = fetch) {
  let sending = false;
  function restore(): BookingState {
    try {
      const saved = storage.getItem(BOOKING_STORAGE_KEY);
      if (!saved) return { kind: "ready" };
      const data: unknown = JSON.parse(saved);
      if (typeof data !== "object" || data === null || !("operationId" in data) || typeof data.operationId !== "string" || !UUID_PATTERN.test(data.operationId)) return { kind: "blocked" };
      if ("reference" in data && typeof data.reference === "string" && UUID_PATTERN.test(data.reference)) return { kind: "confirmed", reference: data.reference };
      return { kind: "unknown" };
    } catch { return { kind: "blocked" }; }
  }
  return {
    restore,
    async confirm(eventId: string): Promise<BookingState> {
      if (sending) return { kind: "pending" };
      const prior = restore();
      if (prior.kind !== "ready") return prior;
      sending = true;
      let reservationSent = false;
      try {
        const operation = { operationId: crypto.randomUUID(), eventId };
        storage.setItem(BOOKING_STORAGE_KEY, JSON.stringify(operation));
        const session = await send("/api/session", { method: "POST", signal: AbortSignal.timeout(10000) });
        if (!session.ok) throw new Error("Session unavailable");
        reservationSent = true;
        const response = await send("/api/reservations", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ eventId, quantity: 1 }), signal: AbortSignal.timeout(10000),
        });
        const payload: unknown = await response.json();
        if (response.status === 201 && isReservation(payload) && payload.event.eventId === eventId) {
          // If saving fails, keep the pre-send marker to block an uncertain resubmit.
          try { storage.setItem(BOOKING_STORAGE_KEY, JSON.stringify({ ...operation, reference: payload.reference })); } catch {}
          return { kind: "confirmed", reference: payload.reference };
        }
        if ([400, 401, 403, 404, 409, 415].includes(response.status) && typeof payload === "object" && payload !== null && "error" in payload &&
            typeof payload.error === "object" && payload.error !== null && "code" in payload.error && typeof payload.error.code === "string") {
          const message = rejectionMessages[payload.error.code];
          if (message) {
            storage.removeItem(BOOKING_STORAGE_KEY);
            return { kind: "rejected", message };
          }
        }
        return { kind: "unknown" };
      } catch {
        if (reservationSent) return { kind: "unknown" };
        try { storage.removeItem(BOOKING_STORAGE_KEY); } catch { return { kind: "blocked" }; }
        return { kind: "rejected", message: "Your browser could not prepare the booking. No reservation was sent. Try again." };
      } finally { sending = false; }
    },
  };
}
