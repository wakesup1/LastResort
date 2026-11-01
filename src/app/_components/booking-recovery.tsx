import Link from "next/link";
import { useId } from "react";
import { Icon, Notice, StatusBadge } from "./ui.tsx";
import { PageHeading } from "./page-heading.tsx";
import type { BookingState } from "../_lib/booking.ts";

export function BookingRecovery({ booking, onCheck, showHistory = true, prominent = false }: {
  booking: BookingState;
  onCheck: () => Promise<void>;
  showHistory?: boolean;
  prominent?: boolean;
}) {
  const headingId = useId();
  if (booking.kind !== "unknown" && booking.kind !== "checking" && booking.kind !== "blocked") return null;
  const blocked = booking.kind === "blocked";
  const checking = booking.kind === "checking";
  const title = blocked ? "Booking is unavailable in this tab." : "We haven't confirmed the result yet.";

  return <section className="booking-recovery" aria-labelledby={headingId}>
    <StatusBadge tone="warning">{blocked ? "Booking unavailable" : "Result to check"}</StatusBadge>
    {prominent ? <PageHeading id={headingId} className="page-title recovery-title">{title}</PageHeading> : <h2 id={headingId} className="recovery-title">{title}</h2>}
    <p className="page-description">{blocked ? "Keep any existing result link. Do not clear browser data to retry an uncertain booking." : "Your request may have completed. Check its result before starting another booking, including in another tab."}</p>
    <div role="status" aria-live="polite" aria-atomic="true">
      <Notice tone="warning" title={checking ? "Checking your booking result…" : blocked ? "The saved request could not be read safely." : "Keep your original request."}>
        {blocked ? "Use My bookings in the original browser to read existing tickets. Opening an older ticket does not resolve a different uncertain request." :
          checking ? "Reading your original request. This does not reserve another ticket." :
          booking.message ?? "Checking reads the existing result. It does not reserve another ticket. Keep this browser's cookies, even after a reload."}
      </Notice>
    </div>
    <div className="review-actions">
      {!blocked && <button className="button button-primary" type="button" aria-disabled={checking} onClick={() => { if (!checking) void onCheck(); }}><Icon name="refresh" />{checking ? "Checking result…" : "Check booking result"}</button>}
      {showHistory && <Link className="text-action" href="/history">My bookings <Icon name="arrow" /></Link>}
    </div>
  </section>;
}
