import { describe, expect, it, vi } from "vitest";
import { inventoryMatches, latency, metrics, parseBaselineArgs, readBookingDiagnostic, runWorkers, type Attempt } from "../scripts/baseline-metrics.ts";

const attempt = (index: number, durationMs: number, outcome: Attempt["outcome"], status: number | null): Attempt => ({ index, worker: 0, durationMs, outcome, status });

describe("HTTP baseline evidence (S3-02)", () => {
  it("bounds the closed-loop workload and never accepts an external target or retry option", () => {
    expect(parseBaselineArgs([])).toEqual([1, 5, 10]);
    expect(parseBaselineArgs(["--concurrency", "2,5"])).toEqual([2, 5]);
    for (const args of [["--url", "https://public-demo.invalid"], ["--retry", "2"], ["--concurrency", "0"], ["--concurrency", "11"], ["--concurrency", "1,1"], ["--concurrency", "1,2,3,4"], ["--concurrency", "private-secret"]]) {
      expect(() => parseBaselineArgs(args)).toThrow();
      try { parseBaselineArgs(args); } catch (error) { expect(String(error)).not.toMatch(/private-secret|public-demo/); }
    }
  });

  it("uses nearest-rank percentiles without changing or dropping observed latencies", () => {
    const values = [100, 1, 2, 3, 4];
    expect(latency(values)).toEqual({ samples: 5, p50Ms: 3, p95Ms: 100, maxMs: 100 });
    expect(values).toEqual([100, 1, 2, 3, 4]);
    expect(latency([])).toEqual({ samples: 0, p50Ms: null, p95Ms: null, maxMs: null });
    for (const value of [NaN, Infinity, -1]) expect(() => latency([value])).toThrow();
  });

  it("includes timeouts and unavailable responses while separating business rejections from technical errors", () => {
    const data = [attempt(0, 10, "confirmed", 201), attempt(1, 20, "sold_out", 409), attempt(2, 10000, "timeout", null), attempt(3, 30, "unexpected", 503)];
    const result = metrics(data, 20000);
    expect(result.allLatency).toEqual({ samples: 4, p50Ms: 20, p95Ms: 10000, maxMs: 10000 });
    expect(result.confirmedLatency.samples).toBe(1);
    expect(result.soldOutLatency.samples).toBe(1);
    expect(result.statuses).toEqual({ "201": 1, "409": 1, "503": 1, no_response: 1 });
    expect(result.errorRate).toBe(0.5);
    expect(result.businessRejectionRate).toBe(0.25);
    expect(result.nonSuccessRate).toBe(0.75);
    expect(result.requestsPerSecond).toBe(0.2);
    expect(result.confirmationsPerSecond).toBe(0.05);
    expect(metrics([], 1).errorRate).toBeNull();
    expect(() => metrics(data, 0)).toThrow();
  });

  it("checks post-load inventory against HTTP outcomes, including missing and incomplete operations", () => {
    const data = [attempt(0, 10, "confirmed", 201), attempt(1, 20, "sold_out", 409)];
    const snapshot = { capacity: 1, remaining: 0, confirmed: 1, operations: 2, soldOut: 1, incomplete: 0 };
    expect(inventoryMatches(snapshot, data, 1, 2)).toBe(true);
    for (const changed of [{ remaining: -1 }, { remaining: 1 }, { confirmed: 2 }, { operations: 1 }, { soldOut: 0 }, { incomplete: 1 }]) {
      expect(inventoryMatches({ ...snapshot, ...changed }, data, 1, 2)).toBe(false);
    }
    expect(inventoryMatches(snapshot, [data[0]], 1, 2)).toBe(false);
    expect(inventoryMatches(snapshot, [data[0], attempt(1, 10000, "timeout", null)], 1, 2)).toBe(false);
  });

  it("runs each distinct operation once and measures peak in-flight work instead of total requests", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started: number[] = [];
    const execute = vi.fn(async (index: number) => { started.push(index); await gate; return index; });
    const workload = runWorkers(20, 3, execute);
    expect(started).toEqual([0, 1, 2]);
    release?.();
    const result = await workload;
    expect(result.peakInFlight).toBe(3);
    expect(result.results).toEqual(Array.from({ length: 20 }, (_, index) => index));
    expect(execute).toHaveBeenCalledTimes(20);
    expect(new Set(started).size).toBe(20);
  });

  it("settles other workers before propagating a worker failure, without retrying the failed operation", async () => {
    const finished: number[] = [];
    const execute = vi.fn(async (index: number) => {
      if (index === 0) throw new Error("private-driver-error");
      await Promise.resolve();
      finished.push(index);
      return index;
    });
    await expect(runWorkers(5, 2, execute)).rejects.toThrow("A workload worker failed; all workers have settled.");
    expect(finished).toEqual([1, 2, 3, 4]);
    expect(execute.mock.calls.filter(([index]) => index === 0)).toHaveLength(1);
  });

  it("retains partial completed work on interruption without inventing missing results", async () => {
    let stop = false;
    const result = await runWorkers(20, 1, async (index) => { stop = true; return index; }, () => stop);
    expect(result.results).toEqual([0]);
    expect(result.peakInFlight).toBe(1);
    await expect(runWorkers(1, 2, async () => 0)).rejects.toThrow();
  });

  it("extracts only safe diagnostic timing and ignores raw errors, URLs, cookies and unrelated records", () => {
    const requestId = "6bda9f21-c452-44fa-9468-f34f59159f31";
    const line = JSON.stringify({ route: "reservations.create", requestId, durationMs: 25, cookie: "private-cookie", error: "postgresql://private:secret@internal/database" });
    expect(readBookingDiagnostic(line)).toEqual({ requestId, durationMs: 25 });
    expect(JSON.stringify(readBookingDiagnostic(line))).not.toMatch(/private|secret|postgresql|cookie/);
    for (const input of ["raw secret", "null", "{}", JSON.stringify({ route: "health", requestId, durationMs: 1 }), JSON.stringify({ route: "reservations.create", requestId, durationMs: -1 })]) expect(readBookingDiagnostic(input)).toBeNull();
  });
});
