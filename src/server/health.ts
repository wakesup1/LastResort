type Query = (sql: string) => Promise<unknown>;

export async function checkHealth(query: Query) {
  try {
    await query(`SELECT event.id, event.remaining, event.capacity, event.sale_opens_at, event.sale_closes_at,
                       guest.id, guest.token_hash, guest.expires_at,
                       reservation.reference, reservation.quantity, reservation.status,
                       operation.operation_key, operation.event_id, operation.quantity, operation.response
                  FROM lastresort.events AS event
                  CROSS JOIN lastresort.guest_sessions AS guest
                  CROSS JOIN lastresort.reservations AS reservation
                  CROSS JOIN lastresort.booking_operations AS operation
                 LIMIT 0`);
    return { status: 200, body: { status: "ok", database: "ready" } };
  } catch {
    return { status: 503, body: { status: "unavailable", database: "unavailable" } };
  }
}
