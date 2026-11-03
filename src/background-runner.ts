export type BackgroundJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
export interface BackgroundJob { id: string; goal: string; status: BackgroundJobStatus; attempts: number; createdAt: string; updatedAt: string; startedAt?: string; finishedAt?: string; checkpoint?: string; result?: string; error?: string }
export interface BackgroundJobStore { version: 1; jobs: BackgroundJob[] }
const MAX_JOBS = 100;
const MAX_GOAL = 500;
export function createJobStore(): BackgroundJobStore { return { version: 1, jobs: [] }; }
export function enqueueJob(store: BackgroundJobStore, goal: string, now = new Date().toISOString()): BackgroundJob {
  const clean = goal.trim().replace(/\s+/g, " ");
  if (!clean || clean.length > MAX_GOAL) throw new Error(`Job goal must contain 1-${MAX_GOAL} characters.`);
  if (store.jobs.length >= MAX_JOBS) {
    const index = store.jobs.findIndex((job) => ["succeeded", "failed", "cancelled"].includes(job.status));
    if (index < 0) throw new Error("Background job limit reached; finish or remove an existing job first.");
    store.jobs.splice(index, 1);
  }
  const job: BackgroundJob = { id: crypto.randomUUID(), goal: clean, status: "queued", attempts: 0, createdAt: now, updatedAt: now };
  store.jobs.push(job);
  return job;
}
export function recoverJobs(store: BackgroundJobStore, now = new Date().toISOString()): number {
  let count = 0;
  for (const job of store.jobs) if (job.status === "running") {
    job.status = "interrupted";
    job.error = "Process stopped during execution. Resume only after inspecting the saved checkpoint.";
    job.updatedAt = now;
    count++;
  }
  return count;
}
export function claimJob(store: BackgroundJobStore, now = new Date().toISOString()): BackgroundJob | undefined {
  const job = store.jobs.find((item) => item.status === "queued");
  if (!job) return undefined;
  job.status = "running"; job.attempts++; job.startedAt = now; job.updatedAt = now; job.error = undefined;
  return job;
}
export function checkpointJob(job: BackgroundJob, checkpoint: string, now = new Date().toISOString()): void {
  if (job.status !== "running") throw new Error("Only running jobs can checkpoint.");
  job.checkpoint = checkpoint.slice(0, 2000); job.updatedAt = now;
}
export function finishJob(job: BackgroundJob, status: "succeeded" | "failed" | "cancelled", result?: string, error?: string, now = new Date().toISOString()): void {
  if (job.status !== "running") throw new Error("Only running jobs can finish.");
  job.status = status; job.result = result?.slice(0, 8000); job.error = error?.slice(0, 1000); job.finishedAt = now; job.updatedAt = now;
}
export function resumeJob(store: BackgroundJobStore, idPrefix: string): BackgroundJob | undefined {
  const matches = store.jobs.filter((job) => job.id.startsWith(idPrefix));
  if (matches.length !== 1 || !["interrupted", "failed"].includes(matches[0]!.status)) return undefined;
  const job = matches[0]!; job.status = "queued"; job.error = undefined; job.finishedAt = undefined; job.updatedAt = new Date().toISOString(); return job;
}
export async function loadJobStore(path: string): Promise<BackgroundJobStore> {
  try {
    const parsed = JSON.parse(await Bun.file(path).text()) as BackgroundJobStore;
    if (parsed.version !== 1 || !Array.isArray(parsed.jobs)) return createJobStore();
    return { version: 1, jobs: parsed.jobs.filter((job) => job && typeof job.id === "string" && typeof job.goal === "string" && ["queued", "running", "succeeded", "failed", "cancelled", "interrupted"].includes(job.status)).slice(-MAX_JOBS) };
  } catch { return createJobStore(); }
}
export async function saveJobStore(path: string, store: BackgroundJobStore): Promise<void> {
  const { mkdir, writeFile, chmod, rename } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await chmod(temp, 0o600); await rename(temp, path);
}


/** Serialize read-modify-write operations across TUI and worker processes. */
export async function withJobStoreTransaction<T>(path: string, mutate: (store: BackgroundJobStore) => T | Promise<T>, options: { waitMs?: number } = {}): Promise<T> {
  const { mkdir, open, readFile, unlink } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + Math.max(0, options.waitMs ?? 5000);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  while (!handle) {
    try { handle = await open(lockPath, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Never steal a lock with an unreadable/incomplete owner record.
      try {
        const owner = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: number };
        if (Number.isSafeInteger(owner.pid) && owner.pid! > 0) {
          try { process.kill(owner.pid!, 0); }
          catch (probe) {
            if ((probe as NodeJS.ErrnoException).code === "ESRCH") await unlink(lockPath).catch(() => undefined);
          }
        }
      } catch { /* owner may be writing its record; wait rather than steal */ }
      if (Date.now() >= deadline) throw new Error("Timed out waiting for the background job store lock.");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
    await handle.sync();
    const store = await loadJobStore(path);
    const result = await mutate(store);
    await saveJobStore(path, store);
    return result;
  } finally {
    await handle.close();
    await unlink(lockPath).catch(() => undefined);
  }
}
