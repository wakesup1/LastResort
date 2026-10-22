import { isReservation, type Reservation } from "./booking.ts";

export type HistoryPage = { reservations: Reservation[]; nextCursor: string | null };

export async function loadHistoryPage(before: string | null, signal: AbortSignal, send: typeof fetch = fetch): Promise<HistoryPage | "session-required"> {
  const response = await send(`/api/reservations${before ? `?before=${encodeURIComponent(before)}` : ""}`, {
    cache: "no-store", credentials: "same-origin", signal,
  });
  if (response.status === 401) return "session-required";
  if (!response.ok) throw new Error("History unavailable");
  const payload: unknown = await response.json();
  if (typeof payload !== "object" || payload === null || !("reservations" in payload) ||
      !Array.isArray(payload.reservations) || !payload.reservations.every(isReservation) ||
      payload.reservations.length > 20 || !("nextCursor" in payload)) throw new Error("Invalid history");
  const reservations: Reservation[] = payload.reservations;
  if (new Set(reservations.map((item) => item.reference)).size !== reservations.length ||
      reservations.some((item) => item.reference === before) ||
      (payload.nextCursor !== null && (reservations.length !== 20 || payload.nextCursor !== reservations.at(-1)?.reference))) {
    throw new Error("Invalid history cursor");
  }
  return { reservations, nextCursor: payload.nextCursor === null ? null : reservations.at(-1)?.reference ?? null };
}
