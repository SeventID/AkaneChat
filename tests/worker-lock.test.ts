import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireWorkerLock } from "../src/worker-lock";

describe("background worker lock", () => {
  test("allows one owner and releases for the next owner", async () => {
    const dir = await mkdtemp(join(tmpdir(), "akane-lock-"));
    const path = join(dir, "worker.lock");
    try {
      const first = await acquireWorkerLock(path);
      expect(first).toBeDefined();
      expect(await acquireWorkerLock(path)).toBeUndefined();
      await first!.heartbeat();
      await first!.release();
      const second = await acquireWorkerLock(path);
      expect(second).toBeDefined();
      await second!.release();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
