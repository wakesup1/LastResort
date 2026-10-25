import { describe, expect, it, vi } from "vitest";
import { loadHistoryPage } from "../src/app/_lib/history.ts";

const reservation = {
  reference: "6bda9f21-c452-44fa-9468-f34f59159f31", status: "confirmed", quantity: 1, createdAt: "2026-10-21T09:00:00Z",
  event: { eventId: "live-sessions-demo", name: "Demo", startsAt: "2026-11-21T12:00:00Z", venue: "Hall", ticketType: "General admission" },
};
const signal = new AbortController().signal;
describe("history browser reads (S2-05)", () => {
  it("reads with the same browser credentials and no cache or booking mutation", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ reservations: [reservation], nextCursor: null }));
    const before = "11111111-1111-4111-8111-111111111111";
    expect(await loadHistoryPage(before, signal, send)).toEqual({ reservations: [reservation], nextCursor: null });
    expect(send).toHaveBeenCalledWith(`/api/reservations?before=${before}`, { cache: "no-store", credentials: "same-origin", signal });
  });
  it("treats an authenticated empty response separately from session loss", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ reservations: [], nextCursor: null })).mockResolvedValueOnce(new Response(null, { status: 401 }));
    expect(await loadHistoryPage(null, signal, send)).toEqual({ reservations: [], nextCursor: null });
    expect(await loadHistoryPage(null, signal, send)).toBe("session-required");
    expect(send).toHaveBeenLastCalledWith("/api/reservations", { cache: "no-store", credentials: "same-origin", signal });
  });
  it.each([404, 500, 503])("does not turn HTTP %s into an empty history", async (status) => {
    await expect(loadHistoryPage(null, signal, vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status })))).rejects.toThrow();
  });
  it("preserves network/timeout errors so the UI can retry the same read", async () => {
    await expect(loadHistoryPage(null, signal, vi.fn<typeof fetch>().mockRejectedValue(new Error("network")))).rejects.toThrow();
  });
  it("accepts a full continuation page and rejects an overlapping cursor", async () => {
    const reservations = Array.from({ length: 20 }, (_, index) => ({ ...reservation, reference: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}` }));
    const page = { reservations, nextCursor: reservations[19].reference };
    const send = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(page));
    expect(await loadHistoryPage(null, signal, send)).toEqual(page);
    await expect(loadHistoryPage(reservations[0].reference, signal, send)).rejects.toThrow();
  });
  it.each([
    {}, { reservations: [], nextCursor: "bad" }, { reservations: [{ ...reservation, status: "pending" }], nextCursor: null },
    { reservations: [reservation, reservation], nextCursor: null }, { reservations: [], nextCursor: reservation.reference },
  ])("rejects malformed pages", async (page) => {
    await expect(loadHistoryPage(null, signal, vi.fn<typeof fetch>().mockResolvedValue(Response.json(page)))).rejects.toThrow();
  });
});
