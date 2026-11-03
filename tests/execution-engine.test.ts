import { describe, expect, test } from "bun:test";
import { beginExecutionStep, finishExecutionStep, nextExecutionDecision, resumeBlockedStep } from "../src/execution-engine";
import { createEmptyTasks, createTask } from "../src/storage/tasks";

describe("durable execution engine", () => {
  test("runs steps in order and completes only after all steps complete", () => {
    const task = createTask(createEmptyTasks(), "ship feature", ["inspect", "implement"]);
    const first = nextExecutionDecision(task);
    expect(first.kind).toBe("ready");
    if (first.kind !== "ready") return;
    const checkpoint = beginExecutionStep(task, first.step, "2026-01-01T00:00:00.000Z");
    finishExecutionStep(task, checkpoint, "completed", "inspection evidence recorded");
    expect(task.status).toBe("in_progress");
    expect(nextExecutionDecision(task).kind).toBe("ready");
    const second = nextExecutionDecision(task);
    if (second.kind !== "ready") return;
    const checkpoint2 = beginExecutionStep(task, second.step);
    finishExecutionStep(task, checkpoint2, "completed", "implementation verified");
    expect(nextExecutionDecision(task).kind).toBe("completed");
    expect(task.status).toBe("completed");
  });
  test("does not skip an active or blocked checkpoint", () => {
    const task = createTask(createEmptyTasks(), "task", ["one", "two"]);
    const decision = nextExecutionDecision(task);
    if (decision.kind !== "ready") throw new Error("expected ready");
    beginExecutionStep(task, decision.step);
    expect(nextExecutionDecision(task).kind).toBe("blocked");
  });
  test("rejects stale checkpoints and allows bounded explicit resume", () => {
    const task = createTask(createEmptyTasks(), "task", ["one"]);
    const decision = nextExecutionDecision(task);
    if (decision.kind !== "ready") throw new Error("expected ready");
    const checkpoint = beginExecutionStep(task, decision.step);
    finishExecutionStep(task, checkpoint, "blocked", "needs user input");
    expect(() => finishExecutionStep(task, checkpoint, "completed", "stale")).toThrow();
    resumeBlockedStep(task, decision.step.id.slice(0, 8));
    expect(nextExecutionDecision(task).kind).toBe("ready");
  });
});
