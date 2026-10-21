import { randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";
import { resolveGuestSession } from "./guest-session.ts";

export type Reservation = {
  reference: string;
  status: "confirmed";
  quantity: 1;
  createdAt: string;
  event: { eventId: string; name: string; startsAt: string; venue: string; ticketType: string };
};

type FailureCode = "SESSION_REQUIRED" | "NOT_FOUND" | "SALES_NOT_OPEN" | "SALES_CLOSED" | "SOLD_OUT";
export type BookingResult = { reservation: Reservation } | { code: FailureCode };
type EventRow = { id: string; name: string; starts_at: Date; venue: string; ticket_type: string };
type BookingClient = {
  query<Row extends QueryResultRow = QueryResultRow>(sql: string, values?: string[]): Promise<{ rows: Row[] }>;
};

export async function readReservation(
  client: BookingClient,
  cookieHeader: string | null,
  reference: string,
): Promise<BookingResult> {
  const session = await resolveGuestSession((sql, values) => client.query(sql, values), cookieHeader);
  if (!session) return { code: "SESSION_REQUIRED" };
  const result = await client.query<EventRow & { reference: string; created_at: Date }>(
    `SELECT event.id, event.name, event.starts_at, event.venue, event.ticket_type,
            reservation.reference, reservation.created_at
       FROM lastresort.reservations AS reservation
       JOIN lastresort.events AS event ON event.id = reservation.event_id
      WHERE reservation.reference = $1 AND reservation.guest_session_id = $2`,
    [reference, session.ownerId],
  );
  const row = result.rows[0];
  if (!row) return { code: "NOT_FOUND" };
  return { reservation: {
    reference: row.reference, status: "confirmed", quantity: 1, createdAt: row.created_at.toISOString(),
    event: { eventId: row.id, name: row.name, startsAt: row.starts_at.toISOString(), venue: row.venue, ticketType: row.ticket_type },
  } };
}

// The caller lends one checked-out client; every statement uses that connection.
export async function reserveTicket(
  client: BookingClient,
  cookieHeader: string | null,
  eventId: string,
): Promise<BookingResult> {
  await client.query("BEGIN");
  try {
    const session = await resolveGuestSession((sql, values) => client.query(sql, values), cookieHeader);
    if (!session) {
      await client.query("ROLLBACK");
      return { code: "SESSION_REQUIRED" };
    }

    const locked = await client.query<{ id: string }>(
      "SELECT id FROM lastresort.events WHERE id = $1 FOR UPDATE", [eventId],
    );
    if (!locked.rows[0]) {
      await client.query("ROLLBACK");
      return { code: "NOT_FOUND" };
    }

    // Evaluate the database clock AFTER any lock wait, once for both boundaries.
    const updated = await client.query<EventRow>(
      `WITH booking_time AS MATERIALIZED (SELECT clock_timestamp() AS checked_at)
       UPDATE lastresort.events AS event
          SET remaining = remaining - 1
         FROM booking_time
        WHERE event.id = $1 AND remaining > 0
          AND sale_opens_at <= booking_time.checked_at
          AND booking_time.checked_at < sale_closes_at
       RETURNING event.id, name, starts_at, venue, ticket_type`,
      [eventId],
    );
    const event = updated.rows[0];
    if (!event) {
      const failure = await client.query<{ code: FailureCode }>(
        `SELECT CASE WHEN clock_timestamp() < sale_opens_at THEN 'SALES_NOT_OPEN'
                     WHEN clock_timestamp() >= sale_closes_at THEN 'SALES_CLOSED'
                     ELSE 'SOLD_OUT' END AS code
           FROM lastresort.events WHERE id = $1`,
        [eventId],
      );
      await client.query("ROLLBACK");
      return { code: failure.rows[0]?.code ?? "NOT_FOUND" };
    }

    const inserted = await client.query<{ reference: string; created_at: Date }>(
      `INSERT INTO lastresort.reservations
         (reference, guest_session_id, event_id, quantity, status)
       VALUES ($1, $2, $3, 1, 'confirmed') RETURNING reference, created_at`,
      [randomUUID(), session.ownerId, eventId],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error("Reservation was not created.");
    const reservation: Reservation = {
      reference: row.reference,
      status: "confirmed",
      quantity: 1,
      createdAt: row.created_at.toISOString(),
      event: {
        eventId: event.id,
        name: event.name,
        startsAt: event.starts_at.toISOString(),
        venue: event.venue,
        ticketType: event.ticket_type,
      },
    };
    await client.query("COMMIT");
    return { reservation };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}
