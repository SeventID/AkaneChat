import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmptyTasks, createTask, deleteTask, formatTask, loadTasks, recoverInterruptedTasks, saveTasks, updateTask, updateTaskStep } from "../src/storage/tasks";

describe("persistent task manager", () => {
  test("creates, progresses, and completes a task from its steps", () => {
    const store = createEmptyTasks();
    const task = createTask(store, "Improve AkaneChat", ["Inspect current architecture", "Implement persistence", "Run tests"]);
    expect(updateTaskStep(store, task.id.slice(0, 8), task.steps[0]!.id.slice(0, 8), "in_progress")?.status).toBe("in_progress");
    updateTaskStep(store, task.id.slice(0, 8), task.steps[0]!.id.slice(0, 8), "completed", "Inspection done");
    updateTaskStep(store, task.id.slice(0, 8), task.steps[1]!.id.slice(0, 8), "completed");
    updateTaskStep(store, task.id.slice(0, 8), task.steps[2]!.id.slice(0, 8), "completed");
    expect(task.status).toBe("completed");
    expect(formatTask(task)).toContain("Inspection done");
  });
  test("persists privately and reloads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "akane-tasks-")); const path = join(dir, "tasks.json");
    try { const store = createEmptyTasks(); createTask(store, "Long running task", ["First stage"]); await saveTasks(path, store); expect((await loadTasks(path)).tasks).toHaveLength(1); expect((await stat(path)).mode & 0o777).toBe(0o600); }
    finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("recovers interrupted in-progress steps as blocked without auto-resuming", () => {
    const store = createEmptyTasks();
    const task = createTask(store, "Interrupted task", ["Running stage", "Later stage"]);
    updateTaskStep(store, task.id.slice(0, 8), task.steps[0]!.id.slice(0, 8), "in_progress");
    expect(recoverInterruptedTasks(store, "2026-11-02T00:00:00.000Z")).toBe(1);
    expect(task.status).toBe("blocked");
    expect(task.steps[0]!.status).toBe("blocked");
    expect(task.steps[0]!.note).toContain("Application restarted");
    expect(task.steps[1]!.status).toBe("pending");
    expect(recoverInterruptedTasks(store)).toBe(0);
  });

  test("handles ambiguous IDs, terminal transitions, and deletion", () => {
    const store = createEmptyTasks(); const task = createTask(store, "Task", ["Step"]);
    expect(updateTask(store, "missing", "completed")).toBeUndefined();
    updateTask(store, task.id.slice(0, 8), "completed");
    expect(() => updateTask(store, task.id.slice(0, 8), "pending")).toThrow();
    expect(deleteTask(store, task.id.slice(0, 8))).toBe(true);
    expect(store.tasks).toHaveLength(0);
  });
  test("rejects invalid and excessive plans", () => {
    const store = createEmptyTasks();
    expect(() => createTask(store, " ")).toThrow();
    expect(() => createTask(store, "Task", Array(31).fill("step"))).toThrow();
  });
  test("does not evict an existing task when new task validation fails", () => {
    const store = createEmptyTasks();
    for (let index = 0; index < 100; index++) createTask(store, `Task ${index}`);
    const oldest = store.tasks[0]!.id;
    expect(() => createTask(store, " ")).toThrow();
    expect(store.tasks).toHaveLength(100);
    expect(store.tasks[0]!.id).toBe(oldest);
  });
  test("never silently evicts unfinished work at capacity", () => {
    const store = createEmptyTasks();
    for (let index = 0; index < 100; index++) createTask(store, `Task ${index}`);
    const ids = store.tasks.map((task) => task.id);
    expect(() => createTask(store, "One more task")).toThrow("Task limit reached");
    expect(store.tasks.map((task) => task.id)).toEqual(ids);
  });
  test("evicts only a completed task when capacity is reached", () => {
    const store = createEmptyTasks();
    for (let index = 0; index < 100; index++) createTask(store, `Task ${index}`);
    updateTask(store, store.tasks[0]!.id.slice(0, 8), "completed");
    const evictedId = store.tasks[0]!.id;
    const created = createTask(store, "Replacement task");
    expect(store.tasks).toHaveLength(100);
    expect(store.tasks.some((task) => task.id === evictedId)).toBe(false);
    expect(store.tasks.at(-1)?.id).toBe(created.id);
  });
});
