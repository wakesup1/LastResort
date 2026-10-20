"use client";

import Link from "next/link";
import { AppShell } from "../_components/app-shell.tsx";
import { EventState } from "../_components/event-state.tsx";
import { Icon, Notice, StatusBadge } from "../_components/ui.tsx";
import { useEventDetails } from "../_hooks/use-event-details.ts";
import { formatEventDate, saleStatusCopy } from "../_lib/event-details.ts";

export default function ReviewBooking() {
  const { state, refresh } = useEventDetails();

  return (
    <AppShell>
      <EventState state={state} onRetry={refresh}>
        {state.kind === "ready" && (
          <div className="reading-container">
            <Link className="button button-secondary back-link" href="/"><Icon name="back" /> Event details</Link>
            <p className="eyebrow">YOUR RESERVATION / REVIEW</p>
            <h1 className="page-title">One place. Yours to review.</h1>
            <p className="page-description">Check the details before reservation confirmation becomes available.</p>
            <div className="ticket summary-ticket">
              <div className="ticket-body">
                <p className="eyebrow">EVENT</p>
                <h2>{state.event.name}</h2>
                <dl className="summary-facts">
                  <div><dt>When</dt><dd><time dateTime={state.event.startsAt}>{formatEventDate(state.event.startsAt)}</time></dd></div>
                  <div><dt>Where</dt><dd>{state.event.venue}</dd></div>
                  <div><dt>Ticket</dt><dd>{state.event.ticketType} × 1</dd></div>
                </dl>
              </div>
              <div className="ticket-stub total-stub"><span className="eyebrow">TOTAL</span><strong>Free</strong><span>No payment required</span></div>
            </div>
            {state.event.saleStatus !== "open" && <div className="review-sale-status"><StatusBadge tone={state.freshness === "current" ? "neutral" : "warning"}>{state.freshness === "current" ? saleStatusCopy(state.event.saleStatus).label : "Availability needs updating"}</StatusBadge><p className="supporting-text">{state.freshness === "current" ? saleStatusCopy(state.event.saleStatus).detail : "Refresh availability to check the current sale status."}</p></div>}
            <Notice title="Reviewing does not reserve a ticket.">Availability will be checked when confirmation is available.</Notice>
            <div className="guest-access-note"><Icon name="monitor" /><p>When booking is available, your ticket will be saved in this browser. Clearing cookies or using another browser will remove access.</p></div>
            <div className="review-actions"><button className="button button-primary" type="button" disabled aria-describedby="confirmation-unavailable">Confirm reservation <Icon name="arrow" /></button><button className="button button-secondary" type="button" onClick={refresh} disabled={state.freshness === "refreshing"}><Icon name="refresh" /> {state.freshness === "refreshing" ? "Updating…" : "Refresh availability"}</button></div>
            <p className="supporting-text confirmation-unavailable" id="confirmation-unavailable">Reservation confirmation is coming soon. No ticket has been reserved.</p>
          </div>
        )}
      </EventState>
    </AppShell>
  );
}
