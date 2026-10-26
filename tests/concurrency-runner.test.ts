import { describe, expect, it, vi } from "vitest";
import { casePassed, createCaseEvidence, parseRuns, readTestCounts, runRounds } from "../scripts/concurrency-evidence.ts";

describe("reproducible concurrency runner (S2-02)", () => {
  it("bounds repeat counts and rejects unsupported flags without echoing input", () => {
    expect(parseRuns([])).toBe(3);
    expect(parseRuns(["--runs", "1"])).toBe(1);
    expect(parseRuns(["--runs", "20"])).toBe(20);
    for (const args of [["--runs", "0"], ["--runs", "21"], ["--runs", "1.5"], ["--retry", "3"], ["--runs", "secret-credential"]]) {
      expect(() => parseRuns(args)).toThrow("Use npm run test:concurrency");
      try { parseRuns(args); } catch (error) { expect(String(error)).not.toContain("secret-credential"); }
    }
  });
  it("keeps only numeric result counts, discarding raw child output and driver secrets", () => {
    const output = JSON.stringify({
      success: false, numPassedTests: 1, numFailedTests: 1,
      testResults: [{ failureMessage: "postgresql://private:secret@internal/database", cookie: "private-session", operationKey: "private-key" }],
    });
    expect(readTestCounts(output)).toEqual({ success: false, passed: 1, failed: 1 });
    expect(JSON.stringify(readTestCounts(output))).not.toMatch(/private|secret|postgresql/);
    for (const value of ["driver secret", "null", "{}", JSON.stringify({ success: true, numPassedTests: "2", numFailedTests: 0 }), JSON.stringify({ success: true, numPassedTests: 2, numFailedTests: -1 })]) {
      expect(readTestCounts(value)).toBeNull();
    }
  });
  it("stops at the first failed round without retrying it or masking it with later success", async () => {
    const execute = vi.fn(async (round: number) => ({ round, status: round === 2 ? "failed" as const : "passed" as const }));
    expect(await runRounds(3, execute)).toEqual([{ round: 1, status: "passed" }, { round: 2, status: "failed" }]);
    expect(execute.mock.calls).toEqual([[1], [2]]);
  });
  it("runs all requested rounds when each round passes", async () => {
    const execute = vi.fn(async (round: number) => ({ round, status: "passed" as const }));
    expect(await runRounds(3, execute)).toHaveLength(3);
    expect(execute.mock.calls).toEqual([[1], [2], [3]]);
  });
  it("never accepts missing, failed, incomplete or wrong-scenario evidence as a passing case", () => {
    const evidence = createCaseEvidence("last-ticket");
    expect(casePassed(evidence, "last-ticket")).toBe(false);
    evidence.status = "passed";
    expect(casePassed(evidence, "last-ticket")).toBe(false);
    evidence.cleanupCompleted = true;
    expect(casePassed(evidence, "last-ticket")).toBe(false);
    evidence.ownershipVerified = true;
    expect(casePassed(evidence, "last-ticket")).toBe(true);
    expect(casePassed(evidence, "capacity-100")).toBe(false);
    expect(casePassed(null, "last-ticket")).toBe(false);
  });
});
