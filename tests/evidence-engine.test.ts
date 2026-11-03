import { describe, expect, test } from "bun:test";
import { createEvidenceLedger, sanitizeEvidenceSummary } from "../src/evidence-engine";

describe("Evidence engine", () => {
  test("records bounded summaries and status counts", () => {
    const ledger = createEvidenceLedger();
    ledger.record("read_file", "succeeded", "Read src/index.ts");
    ledger.record("write_file", "rejected", "User declined update");
    expect(ledger.hasSuccessful("read_file")).toBe(true);
    expect(ledger.hasSuccessful("write_file")).toBe(false);
    expect(ledger.stats()).toEqual({ total: 2, succeeded: 1, failed: 0, rejected: 1, blocked: 0 });
    expect(ledger.summary()).toContain("write_file: rejected");
  });

  test("redacts common credentials and limits summary length", () => {
    expect(sanitizeEvidenceSummary("api_key=supersecret123 and Bearer abcdefghijklmnop")).not.toContain("supersecret123");
    expect(sanitizeEvidenceSummary("x".repeat(800))).toHaveLength(500);
  });

  test("bounds retained evidence", () => {
    const ledger = createEvidenceLedger();
    for (let i = 0; i < 45; i++) ledger.record("read_file", "succeeded", `item ${i}`);
    expect(ledger.list()).toHaveLength(40);
    expect(ledger.list()[0].summary).toBe("item 5");
  });
});
