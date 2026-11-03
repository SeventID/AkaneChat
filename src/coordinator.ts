export interface CoordinatedPlan {
  goal: string;
  steps: string[];
  requiresWorkspace: boolean;
  requiresResearch: boolean;
}

/** Creates a bounded, transparent execution outline without making provider calls. */
export function createCoordinatedPlan(goal: string): CoordinatedPlan {
  const cleanGoal = goal.trim().replace(/\s+/g, " ");
  if (!cleanGoal) throw new Error("A task goal is required.");
  if (cleanGoal.length > 240) throw new Error("Task goal must be at most 240 characters.");

  const lower = cleanGoal.toLowerCase();
  const requiresWorkspace = /\b(code|coding|repo|repository|file|project|bug|debug|implement|refactor|build|test|program|script)\b/.test(lower);
  const requiresResearch = /\b(research|latest|current|compare|evaluate|documentation|docs|benchmark|review|find|investigate)\b/.test(lower);
  const steps = ["Clarify the goal, constraints, and success criteria"];
  if (requiresResearch) steps.push("Gather relevant information and check trustworthy sources");
  if (requiresWorkspace) steps.push("Inspect relevant workspace files before proposing changes");
  steps.push("Create an ordered plan and identify risks or approval requirements");
  steps.push(requiresWorkspace ? "Implement only approved changes in the selected workspace" : "Complete the requested work using the gathered evidence");
  steps.push("Verify the outcome and record any failures or remaining work");
  return { goal: cleanGoal, steps, requiresWorkspace, requiresResearch };
}

export function buildCoordinatorInstructions(): string {
  return [
    "COORDINATOR MODE:",
    "- Treat each multi-step request as a task with a clear goal, constraints, dependencies, and observable completion criteria.",
    "- Choose the smallest useful workflow: inspect, research only when needed, act, then verify.",
    "- Do not spawn parallel agents or invent specialist results. Use available tools and evidence only.",
    "- Keep execution sequential when steps depend on earlier results; stop when blocked or approval is required.",
    "- Never perform destructive, external, financial, account, or deployment actions without explicit user authorization.",
    "- Report completed, verified, blocked, and remaining steps separately.",
  ].join("\n");
}
