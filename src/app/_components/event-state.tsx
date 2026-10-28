import type { ReactNode } from "react";
import type { EventLoadState } from "../_hooks/use-event-details.ts";
import { Icon, Notice } from "./ui.tsx";
import { PageHeading } from "./page-heading.tsx";

export function EventState({ state, onRetry, children }: { state: EventLoadState; onRetry: () => void; children: ReactNode }) {
  return (
    <>
      <p className="sr-only" role="status">
        {state.kind === "ready" ? state.freshness === "refreshing" ? "Updating event availability." : state.freshness === "stale" ? "Availability could not be updated. The displayed details may be out of date." : "Event details and availability loaded." : ""}
      </p>
      {state.kind === "loading" && (
        <section className="loading-state" aria-busy="true" aria-label="Loading event details">
          <p className="eyebrow" role="status">Loading event details…</p>
          <h1>Something good is on its way.</h1>
          <div className="ticket skeleton-ticket" aria-hidden="true">
            <div className="ticket-body"><span className="skeleton skeleton-label" /><span className="skeleton skeleton-title" /><span className="skeleton skeleton-line" /><span className="skeleton skeleton-line short" /></div>
            <div className="ticket-stub"><span className="skeleton skeleton-label" /><span className="skeleton skeleton-title" /><span className="skeleton skeleton-line" /></div>
          </div>
        </section>
      )}
      {(state.kind === "error" || state.kind === "not-found") && (
        <section className="page-state" role={state.kind === "error" ? "alert" : "status"}>
          <span className={`state-symbol ${state.kind === "error" ? "tone-danger" : "tone-neutral"}`}><Icon name={state.kind === "error" ? "warning" : "ticket"} /></span>
          <p className="eyebrow">{state.kind === "error" ? "TEMPORARY ISSUE" : "EVENT NOT FOUND"}</p>
          <PageHeading>{state.kind === "error" ? "We couldn’t load this event." : "This event isn’t available."}</PageHeading>
          <p>{state.kind === "error" ? "The event details are unavailable right now. Please try again." : "It may have been removed or the link may be out of date."}</p>
          <button className="button button-primary" type="button" onClick={onRetry}>{state.kind === "error" ? "Try again" : "Check again"}</button>
        </section>
      )}
      {state.kind === "ready" && state.freshness === "stale" && <div className="refresh-warning" role="alert"><Notice tone="warning" title="Availability couldn’t be updated.">These are the last loaded details. Refresh availability before continuing.</Notice></div>}
      {children}
    </>
  );
}
