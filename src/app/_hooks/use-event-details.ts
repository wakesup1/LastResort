"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isEventDetails, type EventDetails } from "../_lib/event-details.ts";

export type EventLoadState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "not-found" }
  | { kind: "ready"; event: EventDetails; freshness: "current" | "refreshing" | "stale" };

export function useEventDetails() {
  const [state, setState] = useState<EventLoadState>({ kind: "loading" });
  const activeRequest = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setState((previous) => previous.kind === "ready" ? { ...previous, freshness: "refreshing" } : { kind: "loading" });

    try {
      const response = await fetch("/api/events/live-sessions-demo", {
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (response.status === 404) {
        setState({ kind: "not-found" });
        return;
      }
      if (!response.ok) throw new Error("Event unavailable");
      const payload: unknown = await response.json();
      if (controller.signal.aborted) return;
      if (!isEventDetails(payload)) throw new Error("Invalid event details");
      setState({ kind: "ready", event: payload, freshness: "current" });
    } catch {
      if (controller.signal.aborted) return;
      setState((previous) => previous.kind === "ready" ? { ...previous, freshness: "stale" } : { kind: "error" });
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => activeRequest.current?.abort();
  }, [refresh]);

  return { state, refresh: () => { void refresh(); } };
}
