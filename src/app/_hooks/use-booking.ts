"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createBookingController, type BookingState } from "../_lib/booking.ts";

export function useBooking() {
  const router = useRouter();
  const [booking, setBooking] = useState<BookingState>({ kind: "loading" });
  const controller = useRef<ReturnType<typeof createBookingController> | null>(null);
  useEffect(() => {
    try {
      controller.current = createBookingController(window.sessionStorage);
      setBooking(controller.current.restore());
    } catch { setBooking({ kind: "blocked" }); }
  }, []);
  return {
    booking,
    confirm: async (eventId: string) => {
      if (!controller.current) return;
      setBooking({ kind: "pending" });
      const result = await controller.current.confirm(eventId);
      setBooking(result);
      if (result.kind === "confirmed") router.push(`/reservations/${result.reference}`);
    },
  };
}
