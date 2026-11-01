"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppShell } from "../_components/app-shell.tsx";
import { GuestAccessNotice, Icon, Notice, StatusBadge } from "../_components/ui.tsx";
import { PageHeading } from "../_components/page-heading.tsx";
import { formatEventDate } from "../_lib/event-details.ts";
import { loadHistoryPage, type HistoryPage } from "../_lib/history.ts";
import { useBooking } from "../_hooks/use-booking.ts";
import { BookingRecovery } from "../_components/booking-recovery.tsx";

type HistoryState = HistoryPage & { kind: "loading" | "ready" | "error" | "session-required"; loadingMore: boolean };
const emptyPage: HistoryPage = { reservations: [], nextCursor: null };

export default function BookingHistory() {
  const { booking, check } = useBooking();
  const [state, setState] = useState<HistoryState>({ ...emptyPage, kind: "loading", loadingMore: false });
  const active = useRef<AbortController | null>(null);
  const focusReference = useRef<string | null>(null);
  const load = useCallback(async (before: string | null = null, focusResult = false) => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setState((prior) => before ? { ...prior, kind: "loading", loadingMore: true } : { ...emptyPage, kind: "loading", loadingMore: false });
    try {
      const page = await loadHistoryPage(before, AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]));
      if (controller.signal.aborted) return;
      if (page === "session-required") { focusReference.current = focusResult ? "" : null; setState({ ...emptyPage, kind: "session-required", loadingMore: false }); return; }
      focusReference.current = before || focusResult ? page.reservations[0]?.reference ?? "" : null;
      setState((prior) => ({
        kind: "ready", loadingMore: false, nextCursor: page.nextCursor,
        reservations: before ? [...prior.reservations, ...page.reservations] : page.reservations,
      }));
    } catch {
      if (!controller.signal.aborted) {
        if (focusResult) focusReference.current = "";
        setState((prior) => ({ ...prior, kind: "error", loadingMore: false }));
      }
    }
  }, []);
  useEffect(() => { void load(); return () => active.current?.abort(); }, [load]);
  useEffect(() => {
    if (focusReference.current !== null) {
      document.getElementById(focusReference.current ? `ticket-${focusReference.current}` : "history-heading")?.focus();
      focusReference.current = null;
    }
  }, [state.kind, state.reservations]);

  return <AppShell><div className="reading-container">
    <p className="eyebrow">YOUR RESERVATIONS / HISTORY</p>
    <PageHeading id="history-heading">My bookings.</PageHeading>
    <p className="page-description">Find confirmed tickets booked in this browser, newest first.</p>
    <GuestAccessNotice />
    <BookingRecovery booking={booking} onCheck={check} showHistory={false} />
    {booking.kind === "rejected" && <div role="status"><Notice title="Original booking result found.">{booking.message}</Notice></div>}
    <div className="review-actions">
      <button type="button" className="text-action" aria-disabled={state.kind === "loading"} onClick={() => { if (state.kind !== "loading") void load(); }}><Icon name="refresh" /> Refresh history</button>
      <Link className="text-action" href="/">Event details</Link>
    </div>
    <p className="history-status supporting-text" role="status" aria-live="polite">{state.kind === "loading" ? state.loadingMore ? "Loading older bookings…" : "Loading booking history…" : state.kind === "ready" && state.reservations.length > 0 ? `${state.reservations.length} confirmed booking${state.reservations.length === 1 ? "" : "s"} shown.` : ""}</p>
    {state.reservations.length > 0 && <ol className="history-list" aria-label="Confirmed bookings">{state.reservations.map((reservation) => <li key={reservation.reference} className="history-card">
      <StatusBadge tone="success">Confirmed · 1 ticket</StatusBadge>
      <h2>{reservation.event.name}</h2>
      <p>{formatEventDate(reservation.event.startsAt)} · {reservation.event.venue}</p>
      <p className="supporting-text">{reservation.event.ticketType} · Free</p>
      <p className="supporting-text">Booked {formatEventDate(reservation.createdAt)}</p>
      <p className="history-reference supporting-text">Reference: {reservation.reference}</p>
      <Link id={`ticket-${reservation.reference}`} className="button button-secondary" href={`/reservations/${reservation.reference}`} aria-label={`View booking ${reservation.reference}`}>View booking <Icon name="arrow" /></Link>
    </li>)}</ol>}
    {state.kind === "error" && <div className="history-message" role="alert"><h2>Booking history could not be loaded.</h2>
      <p>{state.reservations.length ? "Older bookings could not be loaded. The tickets already shown are still here." : "This does not mean your history is empty. Try reading it again."}</p>
      <button type="button" className="button button-primary" onClick={() => { void load(state.nextCursor, true); }}>Try reading again</button>
    </div>}
    {(state.kind === "session-required" || (state.kind === "ready" && state.reservations.length === 0)) && <div className="history-message" role="status">
      <h2>{state.kind === "session-required" ? "This browser cannot access earlier bookings." : "No bookings in this browser yet."}</h2><p>{state.kind === "session-required" ? "There is no valid guest session. For earlier bookings, use the original browser with its original cookies." : "Your confirmed tickets will appear here. You can explore the event to make your first booking."}</p>
      <Link className="button button-primary" href="/">Explore the event <Icon name="arrow" /></Link>
    </div>}
    {state.nextCursor && state.kind !== "error" && <button type="button" className="button button-secondary" disabled={state.kind === "loading"} onClick={() => { void load(state.nextCursor); }}>{state.loadingMore ? "Loading…" : "Load older bookings"}</button>}
  </div></AppShell>;
}
