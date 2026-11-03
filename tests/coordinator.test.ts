import { describe, expect, test } from "bun:test";
import { buildCoordinatorInstructions, createCoordinatedPlan } from "../src/coordinator";

describe("task coordinator", () => {
  test("adds workspace inspection and verification for coding work", () => {
    const plan = createCoordinatedPlan("Debug the project and add tests");
    expect(plan.requiresWorkspace).toBe(true);
    expect(plan.steps.some((step) => step.includes("Inspect relevant workspace"))).toBe(true);
    expect(plan.steps.at(-1)).toContain("Verify");
  });
  test("adds research only when the goal calls for it", () => {
    const plan = createCoordinatedPlan("Research and compare current database options");
    expect(plan.requiresResearch).toBe(true);
    expect(plan.steps.some((step) => step.includes("Gather relevant information"))).toBe(true);
    expect(plan.requiresWorkspace).toBe(false);
  });
  test("rejects empty or oversized goals", () => {
    expect(() => createCoordinatedPlan("  ")).toThrow();
    expect(() => createCoordinatedPlan("x".repeat(241))).toThrow();
  });
  test("sets explicit approval and verification boundaries", () => {
    const instructions = buildCoordinatorInstructions();
    expect(instructions).toContain("stop when blocked or approval is required");
    expect(instructions).toContain("without explicit user authorization");
  });
});
