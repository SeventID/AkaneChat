import type { AgentTask, TaskStep } from "./storage/tasks";

export const MAX_STEP_ATTEMPTS = 2;
export interface ExecutionCheckpoint {
  taskId: string;
  stepId: string;
  attempt: number;
  startedAt: string;
}
export type ExecutionDecision =
  | { kind: "ready"; step: TaskStep; attempt: number }
  | { kind: "blocked"; step: TaskStep; reason: string }
  | { kind: "completed" }
  | { kind: "cancelled" }
  | { kind: "empty" };

/** Selects exactly one next step; never skips a blocked or in-progress checkpoint. */
export function nextExecutionDecision(task: AgentTask, maxAttempts = MAX_STEP_ATTEMPTS): ExecutionDecision {
  if (task.status === "cancelled") return { kind: "cancelled" };
  if (!task.steps.length) return { kind: "empty" };
  const active = task.steps.find((step) => step.status === "in_progress");
  if (active) return { kind: "blocked", step: active, reason: "A step is already in progress; inspect its checkpoint before continuing." };
  const blocked = task.steps.find((step) => step.status === "blocked");
  if (blocked) return { kind: "blocked", step: blocked, reason: "A blocked step must be explicitly resumed or resolved first." };
  const step = task.steps.find((item) => item.status !== "completed" && item.status !== "cancelled");
  if (!step) return { kind: "completed" };
  const attempt = (step.attempts ?? 0) + 1;
  if (attempt > maxAttempts) return { kind: "blocked", step, reason: `Retry limit reached (${maxAttempts}).` };
  return { kind: "ready", step, attempt };
}

export function beginExecutionStep(task: AgentTask, step: TaskStep, now = new Date().toISOString()): ExecutionCheckpoint {
  if (task.status === "cancelled" || step.status !== "pending") throw new Error("Only a pending step in an active task can start.");
  step.status = "in_progress";
  step.attempts = (step.attempts ?? 0) + 1;
  step.updatedAt = now;
  task.status = "in_progress";
  task.updatedAt = now;
  return { taskId: task.id, stepId: step.id, attempt: step.attempts, startedAt: now };
}

export function finishExecutionStep(task: AgentTask, checkpoint: ExecutionCheckpoint, outcome: "completed" | "blocked", note: string, now = new Date().toISOString()): void {
  if (task.id !== checkpoint.taskId) throw new Error("Checkpoint belongs to another task.");
  const step = task.steps.find((item) => item.id === checkpoint.stepId);
  if (!step || step.status !== "in_progress" || step.attempts !== checkpoint.attempt) throw new Error("Checkpoint is stale or no longer active.");
  step.status = outcome;
  step.note = note.trim().slice(0, 240);
  step.updatedAt = now;
  task.status = outcome === "blocked" ? "blocked" : task.steps.every((item) => item.status === "completed") ? "completed" : "in_progress";
  task.updatedAt = now;
}

export function resumeBlockedStep(task: AgentTask, stepPrefix: string): TaskStep {
  if (task.status === "cancelled" || task.status === "completed") throw new Error("Terminal tasks cannot be resumed.");
  const matches = task.steps.filter((step) => step.id.startsWith(stepPrefix));
  if (matches.length !== 1) throw new Error("Step not found or ID prefix is ambiguous.");
  const step = matches[0]!;
  if (step.status !== "blocked") throw new Error("Only a blocked step can be resumed.");
  if ((step.attempts ?? 0) >= MAX_STEP_ATTEMPTS) throw new Error("Retry limit reached; create a new task or revise the plan.");
  step.status = "pending";
  task.status = "pending";
  step.updatedAt = task.updatedAt = new Date().toISOString();
  return step;
}
