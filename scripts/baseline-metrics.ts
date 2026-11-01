export type Outcome = "confirmed" | "sold_out" | "timeout" | "transport_error" | "unexpected";
export type Attempt = { index: number; worker: number; durationMs: number; status: number | null; outcome: Outcome };
export type Inventory = { capacity: number; remaining: number; confirmed: number; operations: number; soldOut: number; incomplete: number };

export function parseBaselineArgs(args: string[]) {
  if (args.length === 0) return [1, 5, 10];
  if (args.length !== 2 || args[0] !== "--concurrency" || !/^(?:[1-9]|10)(?:,(?:[1-9]|10))*$/.test(args[1])) {
    throw new Error("Use npm run test:baseline -- --concurrency <comma-separated distinct values from 1 to 10>.");
  }
  const levels = args[1].split(",").map(Number);
  if (levels.length > 3 || new Set(levels).size !== levels.length) throw new Error("Choose at most three distinct concurrency levels from 1 to 10.");
  return levels;
}

// Nearest-rank percentiles; errors and timeouts retain their observed client duration.
export function latency(values: number[]) {
  if (values.some((value) => !Number.isFinite(value) || value < 0)) throw new Error("Invalid latency observation.");
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (fraction: number) => sorted.length ? sorted[Math.ceil(sorted.length * fraction) - 1] : null;
  return { samples: sorted.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95), maxMs: sorted.at(-1) ?? null };
}

export function metrics(attempts: Attempt[], durationMs: number) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error("A positive measured duration is required.");
  const counts: Record<Outcome, number> = { confirmed: 0, sold_out: 0, timeout: 0, transport_error: 0, unexpected: 0 };
  const statuses: Record<string, number> = {};
  for (const attempt of attempts) {
    counts[attempt.outcome] += 1;
    const status = attempt.status === null ? "no_response" : String(attempt.status);
    statuses[status] = (statuses[status] ?? 0) + 1;
  }
  const errors = counts.timeout + counts.transport_error + counts.unexpected;
  const rate = (count: number) => attempts.length ? count / attempts.length : null;
  return {
    requests: attempts.length, durationMs, counts, statuses,
    allLatency: latency(attempts.map((item) => item.durationMs)),
    confirmedLatency: latency(attempts.filter((item) => item.outcome === "confirmed").map((item) => item.durationMs)),
    soldOutLatency: latency(attempts.filter((item) => item.outcome === "sold_out").map((item) => item.durationMs)),
    errorRate: rate(errors), businessRejectionRate: rate(counts.sold_out), nonSuccessRate: rate(attempts.length - counts.confirmed),
    requestsPerSecond: attempts.length * 1000 / durationMs, confirmationsPerSecond: counts.confirmed * 1000 / durationMs,
  };
}

export function inventoryMatches(inventory: Inventory, attempts: Attempt[], expectedCapacity: number, expectedRequests: number) {
  const confirmed = attempts.filter((item) => item.outcome === "confirmed").length;
  const soldOut = attempts.filter((item) => item.outcome === "sold_out").length;
  return inventory.capacity === expectedCapacity && inventory.remaining >= 0 && inventory.remaining <= inventory.capacity &&
    inventory.remaining + inventory.confirmed === inventory.capacity && inventory.confirmed === confirmed &&
    inventory.operations === expectedRequests && inventory.soldOut === soldOut && inventory.incomplete === 0 &&
    attempts.length === expectedRequests && confirmed === Math.min(expectedCapacity, expectedRequests) &&
    soldOut === Math.max(0, expectedRequests - expectedCapacity);
}

export async function runWorkers<T>(requests: number, concurrency: number, execute: (index: number, worker: number) => Promise<T>, stopped = () => false) {
  if (!Number.isInteger(requests) || requests < 1 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > requests) {
    throw new Error("Invalid bounded workload.");
  }
  let next = 0;
  let active = 0;
  let peakInFlight = 0;
  const results: T[] = [];
  const workers = await Promise.allSettled(Array.from({ length: concurrency }, async (_, worker) => {
    while (!stopped() && next < requests) {
      const index = next++;
      active += 1;
      peakInFlight = Math.max(peakInFlight, active);
      try { results[index] = await execute(index, worker); }
      finally { active -= 1; }
    }
  }));
  if (workers.some((worker) => worker.status === "rejected")) throw new Error("A workload worker failed; all workers have settled.");
  return { results, peakInFlight };
}

export function readBookingDiagnostic(line: string): { requestId: string; durationMs: number } | null {
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null || !("route" in value) || value.route !== "reservations.create" ||
        !("requestId" in value) || typeof value.requestId !== "string" || !/^[0-9a-f-]{36}$/i.test(value.requestId) ||
        !("durationMs" in value) || typeof value.durationMs !== "number" || !Number.isFinite(value.durationMs) || value.durationMs < 0) return null;
    return { requestId: value.requestId, durationMs: value.durationMs };
  } catch { return null; }
}
