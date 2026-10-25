"use client";

import Link from "next/link";
import { AppShell } from "../_components/app-shell.tsx";
import { EventState } from "../_components/event-state.tsx";
import { BookingSummary } from "../_components/booking-summary.tsx";
import { Icon, Notice, StatusBadge } from "../_components/ui.tsx";
import { useEventDetails } from "../_hooks/use-event-details.ts";
import { saleStatusCopy } from "../_lib/event-details.ts";
import { useBooking } from "../_hooks/use-booking.ts";
import { BookingRecovery } from "../_components/booking-recovery.tsx";

export default function ReviewBooking() {
  const { state, refresh } = useEventDetails();
  const { booking, confirm, check } = useBooking();
  const canConfirm = (booking.kind === "ready" || booking.kind === "rejected") && state.kind === "ready" && state.freshness === "current" && state.event.saleStatus === "open";

  return (
    <AppShell>
      <div className="reading-container booking-feedback">
        {booking.kind === "pending" && <div role="status"><Notice title="Confirming reservation…">Keep this page open. Your ticket is confirmed only when the server returns a result.</Notice></div>}
        <BookingRecovery booking={booking} onCheck={check} />
        {booking.kind === "confirmed" && <div role="status"><Notice title="Your reservation was confirmed."><Link href={`/reservations/${booking.reference}`}>Open your original booking result</Link></Notice></div>}
      </div>
      {booking.kind === "rejected" && <div className="reading-container booking-feedback" role="alert"><Notice tone="warning" title="Reservation not completed.">{booking.message}</Notice></div>}
      <EventState state={state} onRetry={refresh}>
        {state.kind === "ready" && (
          <div className="reading-container">
            <Link className="button button-secondary back-link" href="/"><Icon name="back" /> Event details</Link>
            <p className="eyebrow">YOUR RESERVATION / REVIEW</p>
            <h1 className="page-title">One place. Yours to review.</h1>
            <p className="page-description">Review one ticket, then confirm your reservation.</p>
            <BookingSummary event={state.event} />
            {state.event.saleStatus !== "open" && <div className="review-sale-status"><StatusBadge tone={state.freshness === "current" ? "neutral" : "warning"}>{state.freshness === "current" ? saleStatusCopy(state.event.saleStatus).label : "Availability needs updating"}</StatusBadge><p className="supporting-text">{state.freshness === "current" ? saleStatusCopy(state.event.saleStatus).detail : "Refresh availability to check the current sale status."}</p></div>}
            <Notice title="Reviewing does not reserve a ticket.">Availability is checked again when you confirm. There is no payment step.</Notice>
            <div className="guest-access-note"><Icon name="monitor" /><p>Your ticket is accessible in this browser. Clearing cookies or using another browser removes access.</p></div>
            <div className="review-actions"><button className="button button-primary" type="button" disabled={!canConfirm} onClick={() => { void confirm(state.event.eventId); }}>{booking.kind === "pending" ? "Confirming reservation…" : "Confirm reservation"}<Icon name="arrow" /></button><button className="button button-secondary" type="button" onClick={refresh} disabled={state.freshness === "refreshing" || booking.kind === "pending"}><Icon name="refresh" /> {state.freshness === "refreshing" ? "Updating…" : "Refresh availability"}</button></div>
          </div>
        )}
      </EventState>
      {booking.kind === "confirmed" && <div className="reading-container result-link"><Link className="button button-primary" href={`/reservations/${booking.reference}`}>View booking result <Icon name="arrow" /></Link></div>}
    </AppShell>
  );
}
