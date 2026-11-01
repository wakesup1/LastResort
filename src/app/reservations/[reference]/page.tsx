"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppShell } from "../../_components/app-shell.tsx";
import { BookingSummary } from "../../_components/booking-summary.tsx";
import { GuestAccessNotice, Icon, StatusBadge } from "../../_components/ui.tsx";
import { BookingProgress, PageHeading } from "../../_components/page-heading.tsx";
import { BOOKING_STORAGE_KEY, createBookingController, isReservation, type Reservation } from "../../_lib/booking.ts";

type ResultState = { kind: "loading" | "error" | "not-found" | "session-required" } | { kind: "ready"; reservation: Reservation };

export default function BookingResult() {
  const { reference } = useParams<{ reference: string }>();
  const [state, setState] = useState<ResultState>({ kind: "loading" });
  const active = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setState({ kind: "loading" });
    try {
      const response = await fetch(`/api/reservations/${encodeURIComponent(reference)}`, { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
      if (controller.signal.aborted) return;
      if (response.status === 401) { setState({ kind: "session-required" }); return; }
      if ([400, 404].includes(response.status)) { setState({ kind: "not-found" }); return; }
      if (!response.ok) throw new Error("Reservation unavailable");
      const payload: unknown = await response.json();
      if (controller.signal.aborted) return;
      if (!isReservation(payload) || payload.reference.toLowerCase() !== reference.toLowerCase()) throw new Error("Invalid reservation");
      setState({ kind: "ready", reservation: payload });
    } catch { if (!controller.signal.aborted) setState({ kind: "error" }); }
  }, [reference]);
  useEffect(() => { void load(); return () => active.current?.abort(); }, [load]);

  return <AppShell><div className="reading-container">
    {state.kind === "ready" ? <>
      <BookingProgress step="result" />
      <StatusBadge tone="success">Confirmed · 1 ticket</StatusBadge>
      <PageHeading className="page-title result-title">You're confirmed.</PageHeading>
      <p className="page-description">One place is yours. Keep this page to reopen your ticket.</p>
      <BookingSummary event={state.reservation.event} reference={state.reservation.reference} createdAt={state.reservation.createdAt} />
      <div className="review-actions"><Link className="button button-primary" href="/history">View my bookings <Icon name="arrow" /></Link><button type="button" className="text-action" onClick={() => { void load(); }}><Icon name="refresh" /> Refresh result</button></div>
      <GuestAccessNotice />
      <p className="supporting-text result-note">Bookmark this page to reopen your ticket. Refreshing reads the same reservation and never books another ticket. A reference alone does not grant access.</p>
      <div className="review-actions">
        <Link className="text-action" href="/review" onClick={() => {
          try {
            const prior = createBookingController(sessionStorage).restore();
            if (prior.kind === "confirmed" && prior.reference === state.reservation.reference) sessionStorage.removeItem(BOOKING_STORAGE_KEY);
          } catch {}
        }}>Reserve another ticket</Link></div>
    </> : <div className="page-state" role={state.kind === "error" ? "alert" : "status"}>
      <PageHeading focus={state.kind !== "loading"} focusKey={state.kind}>{state.kind === "loading" ? "Loading your reservation…" : state.kind === "error" ? "Your reservation could not be loaded." : state.kind === "session-required" ? "This browser cannot access the reservation." : "This booking isn't available in this browser."}</PageHeading>
      {state.kind !== "loading" && <><p>{state.kind === "error" ? "Try reading the result again. This does not submit a new booking." : "Open the original result link in the browser where you booked, with its original cookies. No new ticket was reserved."}</p>
        {state.kind === "error" && <button type="button" className="button button-primary" onClick={() => { void load(); }}>Try reading again</button>}
        <div className="result-link"><Link className="button button-secondary" href="/">Event details</Link></div></>}
    </div>}
  </div></AppShell>;
}
