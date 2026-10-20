"use client";

import { useCallback, useEffect, useState } from "react";

type SaleStatus = "not_open" | "open" | "closed" | "sold_out";

type EventDetails = {
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

type LoadState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "not-found" }
  | { kind: "event"; event: EventDetails };

const EVENT_ENDPOINT = "/api/events/live-sessions-demo";

function isEventDetails(value: unknown): value is EventDetails {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.eventId === "string" &&
    typeof event.name === "string" &&
    typeof event.startsAt === "string" &&
    typeof event.venue === "string" &&
    typeof event.ticketType === "string" &&
    typeof event.priceMinor === "number" &&
    typeof event.saleOpensAt === "string" &&
    typeof event.saleClosesAt === "string" &&
    ["not_open", "open", "closed", "sold_out"].includes(String(event.saleStatus)) &&
    typeof event.capacity === "number" &&
    typeof event.remaining === "number"
  );
}

function formatEventDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Bangkok",
    timeZoneName: "short",
  }).format(date);
}

function saleStatusCopy(status: SaleStatus) {
  switch (status) {
    case "not_open":
      return { label: "Sales not open yet", detail: "Sales have not opened yet. Check back when the sale window begins." };
    case "open":
      return { label: "Sales are open", detail: "The sale window is open. Check the remaining ticket count below." };
    case "closed":
      return { label: "Sales closed", detail: "The sale window has ended." };
    case "sold_out":
      return { label: "Sold out", detail: "All tickets for this event have been claimed." };
  }
}

function EventPage() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  const loadEvent = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const response = await fetch(EVENT_ENDPOINT, {
        method: "GET",
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      if (response.status === 404) {
        setState({ kind: "not-found" });
        return;
      }
      if (!response.ok) throw new Error("Event could not be loaded");

      const payload: unknown = await response.json();
      if (!isEventDetails(payload)) throw new Error("Event response was invalid");
      setState({ kind: "event", event: payload });
    } catch {
      setState({ kind: "error" });
    }
  }, []);

  useEffect(() => {
    void loadEvent();
  }, [loadEvent]);

  return (
    <main className="page-shell">
      <header className="site-header">
        <a className="brand" href="/" aria-label="Last Resort home">
          <span className="brand-mark" aria-hidden="true">L</span>
          <span>LASTRESORT</span>
        </a>
        <span className="demo-tag">DEMO EVENT</span>
      </header>

      {state.kind === "loading" && (
        <section className="state-card" aria-live="polite" aria-busy="true">
          <span className="state-icon spinner" aria-hidden="true" />
          <p className="eyebrow">EVENT DETAILS</p>
          <h1>Loading event…</h1>
          <p className="muted">Getting the latest event and ticket availability.</p>
        </section>
      )}

      {state.kind === "error" && (
        <section className="state-card" role="alert">
          <span className="state-icon state-icon-error" aria-hidden="true">!</span>
          <p className="eyebrow">TEMPORARY ISSUE</p>
          <h1>We couldn’t load this event</h1>
          <p className="muted">The event details are unavailable right now. Please try again.</p>
          <button className="button button-primary" onClick={() => void loadEvent()}>
            Try again
          </button>
        </section>
      )}

      {state.kind === "not-found" && (
        <section className="state-card" role="status">
          <span className="state-icon state-icon-muted" aria-hidden="true">?</span>
          <p className="eyebrow">EVENT NOT FOUND</p>
          <h1>This event isn’t available</h1>
          <p className="muted">It may have been removed or the link may be out of date.</p>
          <button className="button button-secondary" onClick={() => void loadEvent()}>
            Check again
          </button>
        </section>
      )}

      {state.kind === "event" && <EventDetailsView event={state.event} onRetry={() => void loadEvent()} />}

      <footer className="site-footer">
        <span>LASTRESORT · GUEST BOOKING DEMO</span>
        <span>All times shown in Bangkok time (UTC+7)</span>
      </footer>
    </main>
  );
}

function EventDetailsView({ event, onRetry }: { event: EventDetails; onRetry: () => void }) {
  const status = saleStatusCopy(event.saleStatus);
  const soldOut = event.saleStatus === "sold_out";

  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">A NIGHT TO REMEMBER</p>
          <h1>{event.name}</h1>
          <p className="hero-summary">Good music, good company, and a place saved just for you.</p>
          <div className="hero-meta">
            <span className="meta-icon" aria-hidden="true">◷</span>
            <span>{formatEventDate(event.startsAt)}</span>
          </div>
          <div className="hero-meta">
            <span className="meta-icon" aria-hidden="true">⌖</span>
            <span>{event.venue}</span>
          </div>
        </div>
        <div className="hero-art" aria-hidden="true">
          <div className="art-orbit orbit-one" />
          <div className="art-orbit orbit-two" />
          <div className="art-disc"><span>LIVE<br />SESSIONS</span></div>
          <span className="art-star star-one">✳</span>
          <span className="art-star star-two">✦</span>
          <span className="art-caption">MADE FOR THE MOMENT</span>
        </div>
      </section>

      <section className={`availability-panel status-${event.saleStatus}`} aria-labelledby="availability-title">
        <div className="availability-heading">
          <div>
            <p className="eyebrow">TICKET AVAILABILITY</p>
            <h2 id="availability-title">{status.label}</h2>
          </div>
          <span className="status-pill">
            <span className="status-dot" aria-hidden="true" />
            {status.label}
          </span>
        </div>
        <p className="availability-detail" role="status">{status.detail}</p>
        <div className="availability-bottom">
          <div className="availability-count">
            <span className="count-number">{event.remaining}</span>
            <span className="count-copy">{event.remaining === 1 ? "ticket" : "tickets"} remaining</span>
          </div>
          <div className="ticket-type">
            <span className="ticket-type-label">TICKET</span>
            <strong>{event.ticketType}</strong>
            <span>{event.priceMinor === 0 ? "Free" : formatPrice(event.priceMinor)}</span>
          </div>
        </div>
        {soldOut && <p className="sold-out-note">There are no tickets left for this event.</p>}
        {event.saleStatus === "not_open" && <p className="sale-hint">Sales open {formatEventDate(event.saleOpensAt)}.</p>}
        {event.saleStatus === "closed" && <p className="sale-hint">Sales closed {formatEventDate(event.saleClosesAt)}.</p>}
        {event.saleStatus === "open" && (
          <p className="sale-hint">Sales close {formatEventDate(event.saleClosesAt)}.</p>
        )}
      </section>

      <section className="details-grid" aria-label="Event information">
        <article className="detail-card">
          <span className="detail-icon" aria-hidden="true">✦</span>
          <p className="eyebrow">WHEN</p>
          <h3>{formatEventDate(event.startsAt)}</h3>
          <p>Doors and event timing are set by the organiser.</p>
        </article>
        <article className="detail-card">
          <span className="detail-icon" aria-hidden="true">⌖</span>
          <p className="eyebrow">WHERE</p>
          <h3>{event.venue}</h3>
          <p>Venue details for this demo event.</p>
        </article>
        <article className="detail-card sale-window-card">
          <span className="detail-icon" aria-hidden="true">◷</span>
          <p className="eyebrow">SALE WINDOW</p>
          <h3>{formatEventDate(event.saleOpensAt)}</h3>
          <p>Opens</p>
          <h3 className="sale-close-date">{formatEventDate(event.saleClosesAt)}</h3>
          <p>Closes</p>
        </article>
      </section>

      <section className="booking-note">
        <div>
          <p className="eyebrow">GOOD TO KNOW</p>
          <p>One ticket per request. A booking is confirmed immediately and does not require payment.</p>
        </div>
        <button className="button button-text" onClick={onRetry} aria-label="Refresh event and ticket availability">
          Refresh availability <span aria-hidden="true">↻</span>
        </button>
      </section>
    </>
  );
}

function formatPrice(priceMinor: number): string {
  return new Intl.NumberFormat("en", { style: "currency", currency: "THB" }).format(priceMinor / 100);
}

export default function Home() {
  return <EventPage />;
}
