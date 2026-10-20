import { formatEventDate, type EventDetails } from "../_lib/event-details.ts";

export function EventFacts({ event }: { event: EventDetails }) {
  return <dl className="event-facts"><div><dt>WHEN</dt><dd><time dateTime={event.startsAt}>{formatEventDate(event.startsAt)}</time></dd></div><div><dt>WHERE</dt><dd>{event.venue}</dd></div></dl>;
}

export function SaleWindow({ event }: { event: EventDetails }) {
  return <dl className="sale-window"><div><dt>SALES OPEN</dt><dd><time dateTime={event.saleOpensAt}>{formatEventDate(event.saleOpensAt)}</time></dd></div><div><dt>SALES CLOSE</dt><dd><time dateTime={event.saleClosesAt}>{formatEventDate(event.saleClosesAt)}</time></dd></div></dl>;
}
