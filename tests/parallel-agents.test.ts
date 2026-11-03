import { describe, expect, test } from "bun:test";
import { runParallelAgents } from "../src/parallel-agents";
describe("independent parallel agents", () => {
  test("runs independent assignments concurrently and preserves result identity", async () => {
    let active = 0; let peak = 0;
    const agents = ["explorer", "researcher", "reviewer"].map((role) => ({ id: role, role, prompt: role }));
    const results = await runParallelAgents(agents, async (agent) => { active++; peak = Math.max(peak, active); await Bun.sleep(20); active--; return agent.prompt; }, { concurrency: 2 });
    expect(results).toHaveLength(3); expect(peak).toBe(2); expect(results.map((item) => item.value)).toEqual(["explorer", "researcher", "reviewer"]);
  });
  test("isolates failures instead of cancelling other agents", async () => {
    const results = await runParallelAgents([{ id: "a", role: "a", prompt: "" }, { id: "b", role: "b", prompt: "" }], async (agent) => { if (agent.id === "a") throw new Error("offline"); return "ok"; });
    expect(results[0]?.status).toBe("failed"); expect(results[1]?.status).toBe("succeeded");
  });
});
