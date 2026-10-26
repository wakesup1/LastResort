import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const CONCURRENCY_CASES = {
  "last-ticket": { capacity: 1, operations: 2, connections: 2 },
  "capacity-100": { capacity: 100, operations: 200, connections: 20 },
};
export const CONCURRENCY_SCENARIOS = ["last-ticket", "capacity-100"] as const;
export const CONCURRENCY_TEST_PATTERN = "allows exactly one of two overlapping connections|keeps capacity 100 consistent across 200 distinct operations on 20 connections";
export type Scenario = keyof typeof CONCURRENCY_CASES;
export type InventorySnapshot = { capacity: number; remaining: number; confirmed: number };
export type CaseEvidence = {
  scenario: Scenario;
  workload: { capacity: number; operations: number; connections: number };
  status: "failed" | "passed";
  phase: "setup" | "contending" | "booking" | "verification" | "complete";
  observedContenders: number;
  failedWorkers: number;
  outcomes: { confirmed: number; soldOut: number; other: number };
  observations: (InventorySnapshot & { operation: number })[];
  finalState: InventorySnapshot | null;
  storedReservations: number | null;
  ownershipVerified: boolean;
  cleanupCompleted: boolean;
};

export function createCaseEvidence(scenario: Scenario): CaseEvidence {
  return {
    scenario, workload: { ...CONCURRENCY_CASES[scenario] }, status: "failed", phase: "setup",
    observedContenders: 0, failedWorkers: 0, outcomes: { confirmed: 0, soldOut: 0, other: 0 }, observations: [],
    finalState: null, storedReservations: null, ownershipVerified: false, cleanupCompleted: false,
  };
}

export async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

export async function saveCaseEvidence(evidence: CaseEvidence) {
  const directory = process.env.LASTRESORT_CONCURRENCY_REPORT_DIR;
  if (directory) await writeJson(join(directory, `${evidence.scenario}.json`), evidence);
}

export function parseRuns(args: string[]) {
  if (args.length === 0) return 3;
  if (args.length !== 2 || args[0] !== "--runs" || !/^(?:[1-9]|1[0-9]|20)$/.test(args[1])) {
    throw new Error("Use npm run test:concurrency -- --runs <1-20> (default: 3).");
  }
  return Number(args[1]);
}

// Child output may contain driver errors, SQL values or credentials. Persist only these counts.
export function readTestCounts(output: string): { passed: number; failed: number; success: boolean } | null {
  try {
    const value: unknown = JSON.parse(output);
    if (typeof value !== "object" || value === null || !("success" in value) || typeof value.success !== "boolean" ||
        !("numPassedTests" in value) || typeof value.numPassedTests !== "number" || !Number.isInteger(value.numPassedTests) || value.numPassedTests < 0 ||
        !("numFailedTests" in value) || typeof value.numFailedTests !== "number" || !Number.isInteger(value.numFailedTests) || value.numFailedTests < 0) return null;
    return { passed: value.numPassedTests, failed: value.numFailedTests, success: value.success };
  } catch { return null; }
}

export function casePassed(value: unknown, scenario: Scenario): boolean {
  if (typeof value !== "object" || value === null || !("scenario" in value) || value.scenario !== scenario ||
      !("status" in value) || value.status !== "passed" || !("cleanupCompleted" in value) || value.cleanupCompleted !== true ||
      !("ownershipVerified" in value) || value.ownershipVerified !== true) return false;
  return true;
}

export async function runRounds<T extends { status: "passed" | "failed" }>(runs: number, run: (round: number) => Promise<T>): Promise<T[]> {
  const rounds: T[] = [];
  for (let round = 1; round <= runs; round += 1) {
    const result = await run(round);
    rounds.push(result);
    if (result.status === "failed") break;
  }
  return rounds;
}
