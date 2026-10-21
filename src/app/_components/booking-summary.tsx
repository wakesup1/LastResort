import { formatEventDate } from "../_lib/event-details.ts";

export function BookingSummary({ event, reference }: {
  event: { name: string; startsAt: string; venue: string; ticketType: string };
  reference?: string;
}) {
  return (
    <div className="ticket summary-ticket">
      <div className="ticket-body">
        <p className="eyebrow">EVENT</p><h2>{event.name}</h2>
        <dl className="summary-facts">
          <div><dt>When</dt><dd><time dateTime={event.startsAt}>{formatEventDate(event.startsAt)}</time></dd></div>
          <div><dt>Where</dt><dd>{event.venue}</dd></div>
          <div><dt>Ticket</dt><dd>{event.ticketType} × 1</dd></div>
        </dl>
      </div>
      <div className="ticket-stub total-stub">
        <span className="eyebrow">{reference ? "REFERENCE" : "TOTAL"}</span>
        {reference ? <code className="reservation-reference">{reference}</code> : <strong>Free</strong>}
        <span>{reference ? "1 confirmed ticket · Free" : "No payment required"}</span>
      </div>
    </div>
  );
}
