"use client";

import Link from "next/link";
import { AppShell } from "./_components/app-shell.tsx";
import { EventState } from "./_components/event-state.tsx";
import { EventFacts, SaleWindow } from "./_components/event-facts.tsx";
import { Icon, Notice, StatusBadge } from "./_components/ui.tsx";
import { useEventDetails } from "./_hooks/use-event-details.ts";
import { formatEventDate, saleStatusCopy } from "./_lib/event-details.ts";
import { PageHeading } from "./_components/page-heading.tsx";

export default function Home() {
  const { state, refresh } = useEventDetails();
  const event = state.kind === "ready" ? state.event : null;
  const freshness = state.kind === "ready" ? state.freshness : "current";
  const current = freshness === "current";
  const status = event ? saleStatusCopy(event.saleStatus) : null;

  return (
    <AppShell>
      <EventState state={state} onRetry={refresh}>
        {event && status && (
          <>
            <div className="page-intro"><div><p className="eyebrow">THE NEXT GOOD THING</p><p className="page-tagline">Find your way in.</p></div><p className="intro-aside">Good things.<br />Limited places.</p></div>
            <article className="ticket event-ticket" aria-labelledby="event-name">
              <div className="ticket-body">
                <p className="event-label">FICTIONAL EVENT · GENERAL ADMISSION</p>
                <PageHeading className="event-name" id="event-name">{event.name}</PageHeading>
                <p className="event-description">An evening at {event.venue}.<br />A little time for something good.</p>
                <EventFacts event={event} />
                <div className="ticket-policy"><Icon name="ticket" /><span>{event.ticketType} · One ticket per request</span></div>
              </div>
              <aside className="ticket-stub" aria-label="Ticket availability" aria-busy={freshness === "refreshing"}>
                <StatusBadge tone={current ? status.tone : "warning"}>{current ? status.label : freshness === "refreshing" ? "Updating availability…" : "Availability needs updating"}</StatusBadge>
                <div className="inventory-count"><strong>{event.remaining}</strong><span>{current ? `${event.remaining === 1 ? "ticket" : "tickets"} remaining` : "last known remaining"}</span></div>
                <p className="availability-detail">{current ? status.detail : "This count has not been verified again yet."}</p>
                <div className="price-summary"><span>{event.ticketType}</span><strong>Free</strong></div>
                {current && event.saleStatus === "open" ? <Link className="button button-primary button-block" href="/review">Review booking <Icon name="arrow" /></Link> : <button className="button button-primary button-block" type="button" disabled>{current ? status.action : "Review booking"}</button>}
                <p className="supporting-text stub-note">Reviewing does not reserve a ticket.</p>
                <button className="button button-secondary refresh-button" type="button" onClick={() => { if (freshness !== "refreshing") refresh(); }} aria-disabled={freshness === "refreshing"}><Icon name="refresh" /> {freshness === "refreshing" ? "Updating…" : "Refresh availability"}</button>
                {current && event.saleStatus === "not_open" && <p className="supporting-text sale-hint">Sales open {formatEventDate(event.saleOpensAt)}.</p>}
                {current && event.saleStatus === "closed" && <p className="supporting-text sale-hint">Sales closed {formatEventDate(event.saleClosesAt)}.</p>}
              </aside>
            </article>
            <div className="below-ticket"><SaleWindow event={event} /><p className="supporting-text event-disclaimer">Fictional event. Free admission.<br />All times are in Bangkok (UTC+7).</p></div>
            <Notice title="Explore the event. Review your ticket.">Confirm one free ticket after reviewing. Keep your result link to reopen the reservation in this browser.</Notice>
          </>
        )}
      </EventState>
    </AppShell>
  );
}
