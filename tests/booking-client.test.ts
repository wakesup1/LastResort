import { describe, expect, it, vi } from "vitest";
import { BOOKING_STORAGE_KEY, createBookingController } from "../src/app/_lib/booking.ts";

const reference = "6bda9f21-c452-44fa-9468-f34f59159f31";
const reservation = { reference, status: "confirmed", quantity: 1, createdAt: "2026-10-21T09:00:00Z", event: { eventId: "live-sessions-demo", name: "Demo", venue: "Hall", ticketType: "General admission", startsAt: "2026-11-21T12:00:00Z" } };
function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
describe("browser booking submission guard", () => {
  it("persists before sending, blocks repeated clicks, and reopens the confirmed reference after reload", async () => {
    const saved = storage();
    let complete: ((response: Response) => void) | undefined;
    const pending = new Promise<Response>((resolve) => { complete = resolve; });
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 204 })).mockImplementationOnce(async (_url, options) => {
      const operation = JSON.parse(saved.getItem(BOOKING_STORAGE_KEY) ?? "{}");
      expect(options?.headers).toMatchObject({ "Idempotency-Key": operation.operationId });
      expect(operation.protocol).toBe("idempotent-v1");
      return pending;
    });
    const booking = createBookingController(saved, send);
    const first = booking.confirm("live-sessions-demo");
    expect(await booking.confirm("live-sessions-demo")).toEqual({ kind: "pending" });
    expect(createBookingController(saved, send).restore()).toEqual({ kind: "unknown" });
    complete?.(Response.json(reservation, { status: 201 }));
    expect(await first).toEqual({ kind: "confirmed", reference });
    expect(await createBookingController(saved, send).confirm("live-sessions-demo")).toEqual({ kind: "confirmed", reference });
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("accepts an original confirmed result replayed with HTTP 200", async () => {
    const saved = storage();
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 204 })).mockResolvedValueOnce(Response.json(reservation));
    expect(await createBookingController(saved, send).confirm("live-sessions-demo")).toEqual({ kind: "confirmed", reference });
  });
  it("retains the original operation on a payload conflict without claiming no ticket exists", async () => {
    const saved = storage();
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 204 })).mockResolvedValueOnce(Response.json({ error: { code: "OPERATION_CONFLICT" } }, { status: 409 }));
    expect(await createBookingController(saved, send).confirm("live-sessions-demo")).toEqual({ kind: "unknown" });
    expect(saved.getItem(BOOKING_STORAGE_KEY)).toContain("operationId");
  });
  it.each(["lost-response", "503", "invalid-success"])("keeps an uncertain operation blocked after %s and reload", async (failure) => {
    const saved = storage();
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 204 }));
    if (failure === "lost-response") send.mockRejectedValueOnce(new TypeError("Network error"));
    else send.mockResolvedValueOnce(Response.json({}, { status: failure === "503" ? 503 : 201 }));
    expect(await createBookingController(saved, send).confirm("live-sessions-demo")).toEqual({ kind: "unknown" });
    const original = saved.getItem(BOOKING_STORAGE_KEY);
    expect(await createBookingController(saved, send).confirm("live-sessions-demo")).toEqual({ kind: "unknown" });
    expect(saved.getItem(BOOKING_STORAGE_KEY)).toBe(original);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("permits a new deliberate attempt after a definite sold-out rejection", async () => {
    const saved = storage();
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 204 })).mockResolvedValueOnce(Response.json({ error: { code: "SOLD_OUT" } }, { status: 409 }));
    expect(await createBookingController(saved, send).confirm("live-sessions-demo")).toMatchObject({ kind: "rejected", message: expect.stringContaining("sold out") });
    expect(saved.getItem(BOOKING_STORAGE_KEY)).toBeNull();
  });
  it("never submits a reservation if session preparation fails", async () => {
    const saved = storage();
    const send = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("Network error"));
    expect(await createBookingController(saved, send).confirm("live-sessions-demo")).toMatchObject({ kind: "rejected" });
    expect(send).toHaveBeenCalledOnce();
    expect(saved.getItem(BOOKING_STORAGE_KEY)).toBeNull();
  });
  it("does not send when browser storage is unavailable or corrupt", async () => {
    const saved = storage();
    saved.setItem(BOOKING_STORAGE_KEY, "invalid-json");
    const send = vi.fn<typeof fetch>();
    expect(await createBookingController(saved, send).confirm("live-sessions-demo")).toEqual({ kind: "blocked" });
    saved.getItem = () => { throw new Error("Storage unavailable"); };
    expect(await createBookingController(saved, send).confirm("live-sessions-demo")).toEqual({ kind: "blocked" });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("original-operation recovery (S2-06)", () => {
  function uncertain(protocol = "idempotent-v1") {
    const saved = storage();
    saved.setItem(BOOKING_STORAGE_KEY, JSON.stringify({ operationId: reference, eventId: "live-sessions-demo", protocol }));
    return saved;
  }
  it("recovers after response loss and reload using only an explicit read of the original operation", async () => {
    const saved = storage();
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 204 })).mockRejectedValueOnce(new TypeError("Lost after commit"));
    expect(await createBookingController(saved, send).confirm("live-sessions-demo")).toEqual({ kind: "unknown" });
    const original = JSON.parse(saved.getItem(BOOKING_STORAGE_KEY) ?? "{}");
    const reloaded = createBookingController(saved, send);
    expect(reloaded.restore()).toEqual({ kind: "unknown" });
    expect(send).toHaveBeenCalledTimes(2);
    send.mockResolvedValueOnce(Response.json({ eventId: "live-sessions-demo", outcome: { reservation } }));
    expect(await reloaded.check()).toEqual({ kind: "confirmed", reference });
    expect(send).toHaveBeenLastCalledWith(`/api/booking-operations/${original.operationId}`, expect.objectContaining({ method: "GET", cache: "no-store", credentials: "same-origin" }));
    expect(createBookingController(saved, send).restore()).toEqual({ kind: "confirmed", reference });
    expect(await reloaded.check()).toEqual({ kind: "confirmed", reference });
    expect(send).toHaveBeenCalledTimes(3);
  });
  it.each([401, 404, 503])("preserves uncertainty after HTTP %s without creating a new session or booking", async (status) => {
    const saved = uncertain();
    const original = saved.getItem(BOOKING_STORAGE_KEY);
    const send = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({}, { status }));
    const controller = createBookingController(saved, send);
    expect(await controller.check()).toMatchObject({ kind: "unknown", message: expect.any(String) });
    expect(saved.getItem(BOOKING_STORAGE_KEY)).toBe(original);
    expect(await controller.confirm("live-sessions-demo")).toEqual({ kind: "unknown" });
    expect(send).toHaveBeenCalledOnce();
    expect(await controller.check()).toMatchObject({ kind: "unknown" });
    expect(send.mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
  });
  it.each([{}, { eventId: "other-event", outcome: { reservation } }, { eventId: "live-sessions-demo", outcome: { reservation: { ...reservation, event: { ...reservation.event, eventId: "other-event" } } } }, { eventId: "live-sessions-demo", outcome: { code: "SESSION_REQUIRED" } }, { eventId: "live-sessions-demo", outcome: { reservation, code: "SOLD_OUT" } }])("does not trust a malformed or mismatched outcome", async (payload) => {
    const saved = uncertain();
    const original = saved.getItem(BOOKING_STORAGE_KEY);
    const send = vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload));
    expect(await createBookingController(saved, send).check()).toMatchObject({ kind: "unknown" });
    expect(saved.getItem(BOOKING_STORAGE_KEY)).toBe(original);
  });
  it("allows another check after a network failure", async () => {
    const saved = uncertain();
    const send = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError("Network error")).mockResolvedValueOnce(Response.json({ eventId: "live-sessions-demo", outcome: { reservation } }));
    const controller = createBookingController(saved, send);
    expect(await controller.check()).toMatchObject({ kind: "unknown" });
    expect(await controller.check()).toEqual({ kind: "confirmed", reference });
  });
  it.each(["NOT_FOUND", "SALES_NOT_OPEN", "SALES_CLOSED", "SOLD_OUT"])("resolves persisted %s without a booking mutation", async (code) => {
    const saved = uncertain();
    const send = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ eventId: "live-sessions-demo", outcome: { code } }));
    expect(await createBookingController(saved, send).check()).toMatchObject({ kind: "rejected", message: expect.stringContaining("No ticket was reserved") });
    expect(saved.getItem(BOOKING_STORAGE_KEY)).toBeNull();
    expect(send).toHaveBeenCalledOnce();
  });
  it("keeps legacy, corrupt and unavailable storage blocked from unsafe recovery", async () => {
    const saved = uncertain("legacy");
    const send = vi.fn<typeof fetch>();
    expect(await createBookingController(saved, send).check()).toMatchObject({ kind: "unknown" });
    saved.setItem(BOOKING_STORAGE_KEY, "corrupt");
    expect(await createBookingController(saved, send).check()).toEqual({ kind: "blocked" });
    saved.getItem = () => { throw new Error("Storage unavailable"); };
    expect(await createBookingController(saved, send).check()).toEqual({ kind: "blocked" });
    expect(send).not.toHaveBeenCalled();
  });
  it("blocks repeated checks and confirmation while a read is in flight", async () => {
    const saved = uncertain();
    let complete: ((response: Response) => void) | undefined;
    const pending = new Promise<Response>((resolve) => { complete = resolve; });
    const send = vi.fn<typeof fetch>().mockReturnValue(pending);
    const controller = createBookingController(saved, send);
    const first = controller.check();
    expect(await controller.check()).toEqual({ kind: "checking" });
    expect(await controller.confirm("live-sessions-demo")).toEqual({ kind: "pending" });
    expect(send).toHaveBeenCalledOnce();
    complete?.(Response.json({ eventId: "live-sessions-demo", outcome: { reservation } }));
    expect(await first).toEqual({ kind: "confirmed", reference });
  });
  it("can return confirmation even when saving the recovered reference fails", async () => {
    const saved = uncertain();
    saved.setItem = () => { throw new Error("Storage full"); };
    const send = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ eventId: "live-sessions-demo", outcome: { reservation } }));
    expect(await createBookingController(saved, send).check()).toEqual({ kind: "confirmed", reference });
    expect(createBookingController(saved, send).restore()).toEqual({ kind: "unknown" });
  });
});
