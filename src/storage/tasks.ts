import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type TaskStatus = "pending" | "in_progress" | "completed" | "blocked" | "cancelled";
export interface TaskEvidence { tool: string; status: "succeeded" | "failed" | "rejected" | "blocked"; summary: string; recordedAt: number }
export interface TaskFileChange { path: string; change: "created" | "modified" | "deleted"; before?: string; after?: string }
export interface TaskStep { id: string; title: string; status: TaskStatus; note?: string; evidence?: TaskEvidence[]; fileChanges?: TaskFileChange[]; attempts?: number; updatedAt: string }
export interface AgentTask { id: string; title: string; status: TaskStatus; steps: TaskStep[]; createdAt: string; updatedAt: string }
export interface TaskStore { version: 1; tasks: AgentTask[] }
const MAX_TASKS = 100;
const MAX_STEPS = 30;
const MAX_TEXT = 240;
const terminal = new Set<TaskStatus>(["completed", "cancelled"]);
export function createEmptyTasks(): TaskStore { return { version: 1, tasks: [] }; }

/** Converts interrupted in-progress work into a reviewable blocked checkpoint on startup. */
export function recoverInterruptedTasks(store: TaskStore, now = new Date().toISOString()): number {
  let recovered = 0;
  for (const task of store.tasks) {
    const active = task.steps.filter((step) => step.status === "in_progress");
    if (!active.length) continue;
    for (const step of active) {
      step.status = "blocked";
      step.note = "Application restarted while this stage was running. Inspect its evidence, then explicitly resume if safe.";
      step.updatedAt = now;
      recovered++;
    }
    if (task.status !== "cancelled" && task.status !== "completed") {
      task.status = "blocked";
      task.updatedAt = now;
    }
  }
  return recovered;
}
export async function loadTasks(path: string): Promise<TaskStore> {
  try {
    const value = JSON.parse(await Bun.file(path).text()) as Partial<TaskStore>;
    if (value.version !== 1 || !Array.isArray(value.tasks)) return createEmptyTasks();
    const tasks = value.tasks.filter((task): task is AgentTask => {
      if (!task || typeof task.id !== "string" || typeof task.title !== "string" || task.title.length > MAX_TEXT) return false;
      if (!["pending", "in_progress", "completed", "blocked", "cancelled"].includes(task.status ?? "")) return false;
      if (!Array.isArray(task.steps) || task.steps.length > MAX_STEPS) return false;
      if (typeof task.createdAt !== "string" || typeof task.updatedAt !== "string") return false;
      return task.steps.every((step) => {
        if (!step || typeof step.id !== "string" || typeof step.title !== "string" || step.title.length > MAX_TEXT) return false;
        if (!["pending", "in_progress", "completed", "blocked", "cancelled"].includes(step.status ?? "")) return false;
        if (step.attempts !== undefined && (!Number.isInteger(step.attempts) || step.attempts < 0 || step.attempts > 20)) return false;
        if (step.evidence !== undefined && (!Array.isArray(step.evidence) || step.evidence.length > 40 || !step.evidence.every((entry) => entry && typeof entry.tool === "string" && entry.tool.length <= 80 && ["succeeded", "failed", "rejected", "blocked"].includes(entry.status) && typeof entry.summary === "string" && entry.summary.length <= 500 && Number.isFinite(entry.recordedAt)))) return false;
        return true;
      });
    }).slice(-MAX_TASKS);
    return { version: 1, tasks };
  } catch { return createEmptyTasks(); }
}
function cleanText(text: string): string {
  const result = text.trim().replace(/\s+/g, " ");
  if (!result) throw new Error("Task text cannot be empty.");
  if (result.length > MAX_TEXT) throw new Error(`Task text exceeds ${MAX_TEXT} characters.`);
  return result;
}
export function createTask(store: TaskStore, title: string, stepTitles: string[] = []): AgentTask {
  if (stepTitles.length > MAX_STEPS) throw new Error(`A task can have at most ${MAX_STEPS} steps.`);
  // Validate every user-supplied field before touching the existing task store.
  const cleanTitle = cleanText(title);
  const cleanSteps = stepTitles.map(cleanText);
  const now = new Date().toISOString();
  const task: AgentTask = { id: randomUUID(), title: cleanTitle, status: "pending", steps: cleanSteps.map((item) => ({ id: randomUUID(), title: item, status: "pending", updatedAt: now })), createdAt: now, updatedAt: now };
  if (store.tasks.length >= MAX_TASKS) {
    // Never evict unfinished work silently. Only completed/cancelled tasks are eligible.
    const evictable = store.tasks.findIndex((item) => item.status === "completed" || item.status === "cancelled");
    if (evictable < 0) throw new Error("Task limit reached: complete, cancel, or delete an existing task before creating another.");
    store.tasks.splice(evictable, 1);
  }
  store.tasks.push(task);
  return task;
}
export function updateTask(store: TaskStore, idPrefix: string, status: TaskStatus, note?: string): AgentTask | undefined {
  const matches = store.tasks.filter((task) => task.id.startsWith(idPrefix));
  if (matches.length !== 1) return undefined;
  const task = matches[0]!;
  if (terminal.has(task.status) && task.status !== status) throw new Error("A completed or cancelled task cannot be reopened; create a new task instead.");
  task.status = status;
  task.updatedAt = new Date().toISOString();
  if (note !== undefined) {
    const clean = cleanText(note);
    const step = [...task.steps].reverse().find((item) => item.status === "in_progress") ?? task.steps.find((item) => item.status === "pending");
    if (step) { step.note = clean; step.updatedAt = task.updatedAt; }
  }
  return task;
}
export function updateTaskStep(store: TaskStore, taskPrefix: string, stepPrefix: string, status: TaskStatus, note?: string): TaskStep | undefined {
  const tasks = store.tasks.filter((task) => task.id.startsWith(taskPrefix));
  if (tasks.length !== 1) return undefined;
  const matches = tasks[0]!.steps.filter((step) => step.id.startsWith(stepPrefix));
  if (matches.length !== 1) return undefined;
  const step = matches[0]!;
  if (terminal.has(step.status) && step.status !== status) throw new Error("A completed or cancelled step cannot be reopened.");
  step.status = status;
  if (note !== undefined) step.note = cleanText(note);
  step.updatedAt = new Date().toISOString();
  const task = tasks[0]!;
  task.updatedAt = step.updatedAt;
  if (task.status !== "cancelled") {
    if (task.steps.length && task.steps.every((item) => item.status === "completed")) task.status = "completed";
    else if (status === "blocked") task.status = "blocked";
    else if (status === "in_progress" || task.steps.some((item) => item.status === "completed")) task.status = "in_progress";
  }
  return step;
}
export function deleteTask(store: TaskStore, idPrefix: string): boolean {
  const matches = store.tasks.filter((task) => task.id.startsWith(idPrefix));
  if (matches.length !== 1) return false;
  store.tasks = store.tasks.filter((task) => task.id !== matches[0]!.id);
  return true;
}
export async function saveTasks(path: string, store: TaskStore): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}
export function formatTask(task: AgentTask): string {
  const steps = task.steps.map((step, index) => `  ${index + 1}. [${step.status}] ${step.title}${step.note ? ` — ${step.note}` : ""}`).join("\n");
  return `${task.id.slice(0, 8)} [${task.status}] ${task.title}${steps ? `\n${steps}` : "\n  (no steps yet)"}`;
}
