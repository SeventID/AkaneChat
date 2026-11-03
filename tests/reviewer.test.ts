import { describe, expect, test } from "bun:test";
import { buildReviewPrompt, classifyReviewVerdict } from "../src/reviewer";
import type { AgentTask } from "../src/storage/tasks";

const task: AgentTask = { id: "task-1", title: "Fix login", status: "blocked", createdAt: "now", updatedAt: "now", steps: [{ id: "step-1", title: "Run tests", status: "blocked", note: "Tests reportedly passed", attempts: 1, updatedAt: "now" }] };
describe("read-only reviewer", () => {
  test("asks for evidence and forbids tool use or edits", () => {
    const prompt = buildReviewPrompt({ task, step: task.steps[0]! });
    expect(prompt).toContain("read-only");
    expect(prompt).toContain("Do not call tools");
    expect(prompt).toContain("INSUFFICIENT_EVIDENCE");
    expect(prompt).toContain("Tests reportedly passed");
  });
  test("classifies only an explicit verdict header", () => {
    expect(classifyReviewVerdict("VERDICT: PASS\nEvidence: tests output")).toBe("pass");
    expect(classifyReviewVerdict("VERDICT: NEEDS_WORK")).toBe("needs_work");
    expect(classifyReviewVerdict("VERDICT: INSUFFICIENT_EVIDENCE")).toBe("insufficient_evidence");
    expect(classifyReviewVerdict("Looks good, probably pass")).toBe("unknown");
  });
});
