"use client";

import Link from "next/link";
import { AppShell } from "../_components/app-shell.tsx";
import { EventState } from "../_components/event-state.tsx";
import { BookingSummary } from "../_components/booking-summary.tsx";
import { GuestAccessNotice, Icon, Notice, StatusBadge } from "../_components/ui.tsx";
import { BookingProgress, PageHeading } from "../_components/page-heading.tsx";
import { useEventDetails } from "../_hooks/use-event-details.ts";
import { saleStatusCopy } from "../_lib/event-details.ts";
import { useBooking } from "../_hooks/use-booking.ts";
import { BookingRecovery } from "../_components/booking-recovery.tsx";

export default function ReviewBooking() {
  const { state, refresh } = useEventDetails();
  const { booking, confirm, check } = useBooking();
  const recovery = booking.kind === "unknown" || booking.kind === "checking" || booking.kind === "blocked";
  const canConfirm = booking.kind === "ready" && state.kind === "ready" && state.freshness === "current" && state.event.saleStatus === "open";

  return <AppShell><div className="reading-container">
    {recovery ? <>
      <BookingProgress step="result" />
      <BookingRecovery booking={booking} onCheck={check} prominent />
      {state.kind === "ready" && <div className="recovery-summary"><BookingSummary event={state.event} /></div>}
      <p className="supporting-text recovery-note">The result still needs checking even if sales have closed or tickets have sold out.</p>
    </> : booking.kind === "confirmed" ? <>
      <BookingProgress step="result" />
      <StatusBadge tone="success">Confirmed</StatusBadge>
      <PageHeading className="page-title result-title">Your reservation was confirmed.</PageHeading>
      <p className="page-description">Open your original result. This does not reserve another ticket.</p>
      <Link className="button button-primary" href={`/reservations/${booking.reference}`}>View booking result <Icon name="arrow" /></Link>
    </> : booking.kind === "rejected" ? <>
      <BookingProgress step="result" />
      <PageHeading>No ticket was reserved.</PageHeading>
      <p className="page-description">Review the result before starting another booking.</p>
      <div role="alert"><Notice tone="warning" title="Booking result">{booking.message}</Notice></div>
      {state.kind === "ready" && <div className="recovery-summary"><BookingSummary event={state.event} /></div>}
      <div className="review-actions"><Link className="button button-primary" href="/">Back to event <Icon name="arrow" /></Link></div>
    </> : <EventState state={state} onRetry={refresh}>
      {state.kind === "ready" && <>
        <Link className="text-action back-link" href="/"><Icon name="back" /> Event details</Link>
        <BookingProgress step="review" />
        <PageHeading>Review your booking.</PageHeading>
        <p className="page-description">One ticket. No payment. Confirm when you’re ready.</p>
        <BookingSummary event={state.event} />
        {state.event.saleStatus !== "open" && <div className="review-sale-status"><StatusBadge tone={state.freshness === "current" ? "neutral" : "warning"}>{state.freshness === "current" ? saleStatusCopy(state.event.saleStatus).label : "Availability needs updating"}</StatusBadge><p className="supporting-text">{state.freshness === "current" ? saleStatusCopy(state.event.saleStatus).detail : "Refresh availability to check the current sale status."}</p></div>}
        <Notice title="Reviewing does not reserve a ticket.">Availability is checked when you confirm. There is no payment step.</Notice>
        <GuestAccessNotice />
        <p className="submission-status supporting-text" role="status" aria-live="polite">{booking.kind === "pending" ? "Keep this page open. Your request is being processed. Your ticket is confirmed only when the server returns a result." : ""}</p>
        <div className="review-actions" aria-busy={booking.kind === "pending"}>
          <button className="button button-primary confirm-button" type="button" disabled={!canConfirm} onClick={() => { void confirm(state.event.eventId); }}>{booking.kind === "pending" ? "Confirming reservation…" : "Confirm reservation"}<Icon name="arrow" /></button>
          <button className="text-action" type="button" onClick={() => { if (state.freshness !== "refreshing" && booking.kind !== "pending") refresh(); }} aria-disabled={state.freshness === "refreshing" || booking.kind === "pending"}><Icon name="refresh" />{state.freshness === "refreshing" ? "Updating…" : "Refresh availability"}</button>
        </div>
      </>}
    </EventState>}
  </div></AppShell>;
}
