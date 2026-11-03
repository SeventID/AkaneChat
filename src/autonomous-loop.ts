export type VerificationVerdict = "pass" | "revise" | "blocked";
export interface AutonomousLoopState { goal: string; iteration: number; maxIterations: number; checkpoint: string; lastOutput?: string; lastFeedback?: string }
export interface AutonomousLoopEvent { type: "planned" | "executed" | "verified" | "replanned" | "blocked" | "completed"; iteration: number; detail: string }
export interface AutonomousLoopResult { status: "completed" | "blocked" | "exhausted"; output: string; iterations: number; events: AutonomousLoopEvent[] }
export async function runAutonomousLoop(options: {
  goal: string; maxIterations?: number; signal?: AbortSignal;
  execute: (state: Readonly<AutonomousLoopState>) => Promise<string>;
  verify: (state: Readonly<AutonomousLoopState>, output: string) => Promise<{ verdict: VerificationVerdict; feedback: string }>;
  replan?: (state: Readonly<AutonomousLoopState>, feedback: string) => Promise<string>;
  checkpoint?: (state: Readonly<AutonomousLoopState>) => Promise<void>;
}): Promise<AutonomousLoopResult> {
  const maxIterations = Math.max(1, Math.min(4, Math.floor(options.maxIterations ?? 2)));
  const state: AutonomousLoopState = { goal: options.goal, iteration: 0, maxIterations, checkpoint: "accepted" };
  const events: AutonomousLoopEvent[] = [];
  const emit = (type: AutonomousLoopEvent["type"], detail: string) => events.push({ type, iteration: state.iteration, detail: detail.slice(0, 1000) });
  for (let i = 1; i <= maxIterations; i++) {
    if (options.signal?.aborted) { state.checkpoint = "cancelled"; emit("blocked", "Execution cancelled by user or shutdown."); return { status: "blocked", output: state.lastOutput ?? "", iterations: i - 1, events }; }
    state.iteration = i; state.checkpoint = `iteration-${i}-planned`; emit("planned", state.lastFeedback ?? "Initial execution plan accepted."); await options.checkpoint?.(state);
    const output = await options.execute(state); state.lastOutput = output.slice(0, 24000); state.checkpoint = `iteration-${i}-executed`; emit("executed", "Execution stage returned an output."); await options.checkpoint?.(state);
    const review = await options.verify(state, state.lastOutput); state.lastFeedback = review.feedback.slice(0, 2000); state.checkpoint = `iteration-${i}-verified-${review.verdict}`; emit("verified", `${review.verdict}: ${review.feedback}`); await options.checkpoint?.(state);
    if (review.verdict === "pass") { state.checkpoint = "completed"; emit("completed", "Independent verification passed."); await options.checkpoint?.(state); return { status: "completed", output: state.lastOutput, iterations: i, events }; }
    if (review.verdict === "blocked") { state.checkpoint = "blocked"; emit("blocked", review.feedback); await options.checkpoint?.(state); return { status: "blocked", output: state.lastOutput, iterations: i, events }; }
    if (i < maxIterations) { if (options.replan) state.goal = await options.replan(state, review.feedback); emit("replanned", state.goal); await options.checkpoint?.(state); }
  }
  state.checkpoint = "iteration-budget-exhausted"; emit("blocked", "Maximum autonomous iterations reached without verification passing."); await options.checkpoint?.(state);
  return { status: "exhausted", output: state.lastOutput ?? "", iterations: maxIterations, events };
}
