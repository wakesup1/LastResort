import { formatEventDate } from "../_lib/event-details.ts";

export function BookingSummary({ event, reference, createdAt }: {
  event: { name: string; startsAt: string; venue: string; ticketType: string };
  reference?: string;
  createdAt?: string;
}) {
  return (
    <section className="ticket summary-ticket" aria-label="One ticket summary">
      <div className="ticket-body">
        <p className="event-label">{event.ticketType} · 1 ticket</p><h2 className="summary-event-name">{event.name}</h2>
        <dl className="summary-facts">
          <div><dt>When</dt><dd><time dateTime={event.startsAt}>{formatEventDate(event.startsAt)}</time></dd></div>
          <div><dt>Where</dt><dd>{event.venue}</dd></div>
          <div><dt>Ticket</dt><dd>{event.ticketType} × 1</dd></div>
        </dl>
        {reference && <div className="reference-block"><p className="supporting-text">Reservation reference</p><code className="reservation-reference">{reference}</code>{createdAt && <p className="supporting-text">Booked <time dateTime={createdAt}>{formatEventDate(createdAt)}</time></p>}</div>}
      </div>
      <div className="ticket-stub total-stub">
        <span className="eyebrow">TOTAL</span>
        <strong>Free</strong>
        <span>No payment needed</span>
      </div>
    </section>
  );
}
