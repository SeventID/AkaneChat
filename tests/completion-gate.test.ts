import { describe, expect, test } from "bun:test";
import { evaluateCompletionGate } from "../src/completion-gate";
const change = [{ path: "src/a.ts", change: "modified" as const }];
const evidence = [{ tool: "write_file", status: "succeeded" as const, summary: "Applied approved write", recordedAt: 1 }];
describe("completion evidence gate", () => {
  test("allows evidence to proceed to review but never declares completion", () => {
    expect(evaluateCompletionGate({ changes: change, evidence, requiresCodeChange: true }).verdict).toBe("eligible_for_review");
  });
  test("blocks failed or rejected actions", () => {
    expect(evaluateCompletionGate({ changes: change, evidence: [...evidence, { tool: "write_file", status: "rejected", summary: "no", recordedAt: 2 }], requiresCodeChange: true }).verdict).toBe("blocked");
  });
  test("requires observed changes and successful writes for code tasks", () => {
    expect(evaluateCompletionGate({ changes: [], evidence, requiresCodeChange: true }).verdict).toBe("insufficient_evidence");
  });
});
