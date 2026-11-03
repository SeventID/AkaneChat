import { describe, expect, test } from "bun:test";
import { runAutonomousLoop } from "../src/autonomous-loop";
describe("autonomous execution loop", () => {
  test("executes, verifies, replans and retries within a bounded budget", async () => {
    let executions = 0; const checkpoints: string[] = [];
    const result = await runAutonomousLoop({ goal: "goal", maxIterations: 3, execute: async (state) => { executions++; return `output-${state.iteration}`; }, verify: async (_state, output) => output === "output-2" ? { verdict: "pass", feedback: "checks passed" } : { verdict: "revise", feedback: "missing evidence" }, replan: async (_state, feedback) => `revised: ${feedback}`, checkpoint: async (state) => { checkpoints.push(state.checkpoint); } });
    expect(result.status).toBe("completed"); expect(executions).toBe(2); expect(result.iterations).toBe(2); expect(checkpoints).toContain("iteration-2-verified-pass");
  });
  test("stops on blocked verification and on iteration exhaustion", async () => {
    const blocked = await runAutonomousLoop({ goal: "x", execute: async () => "done", verify: async () => ({ verdict: "blocked", feedback: "approval required" }) });
    expect(blocked.status).toBe("blocked");
    const exhausted = await runAutonomousLoop({ goal: "x", maxIterations: 2, execute: async () => "no", verify: async () => ({ verdict: "revise", feedback: "not done" }) });
    expect(exhausted.status).toBe("exhausted"); expect(exhausted.iterations).toBe(2);
  });
});
