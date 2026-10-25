import Link from "next/link";
import { Icon, Notice } from "./ui.tsx";
import type { BookingState } from "../_lib/booking.ts";

export function BookingRecovery({ booking, onCheck, showHistory = true }: { booking: BookingState; onCheck: () => Promise<void>; showHistory?: boolean }) {
  if (booking.kind !== "unknown" && booking.kind !== "checking" && booking.kind !== "blocked") return null;
  return <section aria-label="Booking result to check" aria-busy={booking.kind === "checking"}>
    <div aria-live="polite" aria-atomic="true">
      <Notice tone="warning" title={booking.kind === "checking" ? "Checking your booking result…" : booking.kind === "blocked" ? "Booking is unavailable in this tab." : "We haven't confirmed the result yet."}>
        {booking.kind === "blocked" ? "We could not safely read the saved booking state. Keep any existing result link; do not clear browser data to retry an uncertain booking." :
          booking.kind === "checking" ? "Reading your original request. This does not reserve another ticket." :
          booking.message ?? "Your request may have completed. Check its result before starting another booking, including in another tab. Checking does not reserve another ticket."}
      </Notice>
    </div>
    <div className="review-actions">
      {booking.kind !== "blocked" && <button className="button button-primary" type="button" disabled={booking.kind === "checking"} onClick={() => { void onCheck(); }}><Icon name="refresh" />{booking.kind === "checking" ? "Checking result…" : "Check booking result"}</button>}
      {showHistory && <Link className="button button-secondary" href="/history">Booking history <Icon name="arrow" /></Link>}
    </div>
  </section>;
}
