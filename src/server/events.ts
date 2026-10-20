export type SaleStatus = "not_open" | "open" | "closed" | "sold_out";

export type EventDetails = {
  eventId: string;
  name: string;
  startsAt: string;
  venue: string;
  ticketType: string;
  priceMinor: number;
  saleOpensAt: string;
  saleClosesAt: string;
  saleStatus: SaleStatus;
  capacity: number;
  remaining: number;
};

type EventRow = {
  id: string;
  name: string;
  starts_at: Date | string;
  venue: string;
  ticket_type: string;
  price_minor: number;
  sale_opens_at: Date | string;
  sale_closes_at: Date | string;
  capacity: number;
  remaining: number;
};

type Query = (sql: string, values: string[]) => Promise<{ rows: EventRow[] }>;

function asIsoString(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export async function readEvent(query: Query, eventId: string, now = new Date()): Promise<EventDetails | null> {
  const result = await query(
    `SELECT id, name, starts_at, venue, ticket_type, price_minor,
            sale_opens_at, sale_closes_at, capacity, remaining
       FROM lastresort.events
      WHERE id = $1`,
    [eventId],
  );
  const row = result.rows[0];
  if (!row) return null;

  const saleOpensAt = asIsoString(row.sale_opens_at);
  const saleClosesAt = asIsoString(row.sale_closes_at);
  const opensAt = new Date(saleOpensAt).getTime();
  const closesAt = new Date(saleClosesAt).getTime();
  let saleStatus: SaleStatus;

  if (now.getTime() < opensAt) {
    saleStatus = "not_open";
  } else if (now.getTime() >= closesAt) {
    saleStatus = "closed";
  } else if (row.remaining === 0) {
    saleStatus = "sold_out";
  } else {
    saleStatus = "open";
  }

  return {
    eventId: row.id,
    name: row.name,
    startsAt: asIsoString(row.starts_at),
    venue: row.venue,
    ticketType: row.ticket_type,
    priceMinor: row.price_minor,
    saleOpensAt,
    saleClosesAt,
    saleStatus,
    capacity: row.capacity,
    remaining: row.remaining,
  };
}
