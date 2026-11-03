import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJobStore, enqueueJob, claimJob, checkpointJob, finishJob, recoverJobs, resumeJob, loadJobStore, withJobStoreTransaction } from "../src/background-runner";
describe("persistent background jobs", () => {
  test("claims, checkpoints, finishes and recovers interrupted jobs", () => {
    const store = createJobStore(); const job = enqueueJob(store, "Build autonomous loop");
    expect(claimJob(store)).toBe(job); checkpointJob(job, "step-2");
    expect(recoverJobs(store)).toBe(1); expect(job.status).toBe("interrupted");
    expect(resumeJob(store, job.id.slice(0, 8))).toBe(job); expect(claimJob(store)).toBe(job);
    finishJob(job, "succeeded", "verified"); expect(job.result).toBe("verified");
  });
  test("rejects invalid goals and protects active jobs at capacity", () => {
    const store = createJobStore(); for (let i = 0; i < 100; i++) enqueueJob(store, `job ${i}`);
    expect(() => enqueueJob(store, " ")).toThrow(); expect(() => enqueueJob(store, "extra")).toThrow("limit");
  });
  test("serializes concurrent read-modify-write operations without losing jobs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "akane-jobs-"));
    const path = join(directory, "jobs.json");
    try {
      const created = await Promise.all(Array.from({ length: 12 }, (_, index) =>
        withJobStoreTransaction(path, (store) => enqueueJob(store, `parallel ${index}`)),
      ));
      const stored = await loadJobStore(path);
      expect(created).toHaveLength(12);
      expect(new Set(stored.jobs.map((job) => job.id)).size).toBe(12);
      expect(stored.jobs).toHaveLength(12);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
