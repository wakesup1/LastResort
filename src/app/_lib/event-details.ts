export type SaleStatus = "not_open" | "open" | "closed" | "sold_out";

export type EventDetails = {
  eventId: string;
  name: string;
  startsAt: string;
  venue: string;
  ticketType: string;
  priceMinor: 0;
  saleOpensAt: string;
  saleClosesAt: string;
  saleStatus: SaleStatus;
  capacity: number;
  remaining: number;
};

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
}

export function isEventDetails(value: unknown): value is EventDetails {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.eventId === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(event.eventId) && event.eventId.length <= 100 &&
    typeof event.name === "string" && event.name.trim().length > 0 &&
    typeof event.venue === "string" && event.venue.trim().length > 0 &&
    typeof event.ticketType === "string" && event.ticketType.trim().length > 0 &&
    event.priceMinor === 0 &&
    isTimestamp(event.startsAt) && isTimestamp(event.saleOpensAt) && isTimestamp(event.saleClosesAt) &&
    Date.parse(event.saleOpensAt) < Date.parse(event.saleClosesAt) && Date.parse(event.saleClosesAt) <= Date.parse(event.startsAt) &&
    (event.saleStatus === "not_open" || event.saleStatus === "open" || event.saleStatus === "closed" || event.saleStatus === "sold_out") &&
    typeof event.capacity === "number" && Number.isSafeInteger(event.capacity) && event.capacity > 0 &&
    typeof event.remaining === "number" && Number.isSafeInteger(event.remaining) && event.remaining >= 0 && event.remaining <= event.capacity
  );
}

export function formatEventDate(value: string): string {
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Bangkok",
    timeZoneName: "short",
  }).format(new Date(value));
}

export function saleStatusCopy(status: SaleStatus) {
  switch (status) {
    case "not_open": return { label: "Sales not open yet", detail: "Sales have not opened for this event yet.", action: "Sales not open", tone: "neutral" as const };
    case "open": return { label: "Sales are open", detail: "Availability is informational. Reviewing does not hold a ticket.", action: "Review booking", tone: "success" as const };
    case "closed": return { label: "Sales closed", detail: "The sale window for this event has ended.", action: "Sales closed", tone: "neutral" as const };
    case "sold_out": return { label: "Sold out", detail: "All tickets for this event have been reserved.", action: "Sold out", tone: "neutral" as const };
  }
}
