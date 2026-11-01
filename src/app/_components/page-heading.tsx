"use client";

import { useEffect, useRef, type ReactNode } from "react";

export function PageHeading({ children, className = "page-title", id, focusKey = "page", focus = true }: {
  children: ReactNode;
  className?: string;
  id?: string;
  focusKey?: string;
  focus?: boolean;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focus) heading.current?.focus();
  }, [focus, focusKey]);
  return <h1 ref={heading} tabIndex={-1} className={className} id={id}>{children}</h1>;
}

export function BookingProgress({ step }: { step: "review" | "result" }) {
  return <ol className="booking-progress" aria-label="Booking progress">
    <li>Event</li>
    <li aria-current={step === "review" ? "step" : undefined}>Review</li>
    <li aria-current={step === "result" ? "step" : undefined}>Result</li>
  </ol>;
}
