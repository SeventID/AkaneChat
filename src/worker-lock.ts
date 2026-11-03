import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";

interface LockRecord { pid: number; startedAt: string; heartbeatAt: string }
export interface WorkerLock { heartbeat(): Promise<void>; release(): Promise<void> }

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export async function acquireWorkerLock(path: string, now = new Date().toISOString()): Promise<WorkerLock | undefined> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const record: LockRecord = { pid: process.pid, startedAt: now, heartbeatAt: now };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, "wx", 0o600);
      try { await handle.writeFile(`${JSON.stringify(record)}\n`); await handle.sync(); }
      finally { await handle.close(); }
      let released = false;
      return {
        heartbeat: async () => {
          if (released) throw new Error("Worker lock has been released.");
          const current = JSON.parse(await readFile(path, "utf8")) as LockRecord;
          if (current.pid !== process.pid || current.startedAt !== record.startedAt) throw new Error("Worker lock ownership was lost.");
          record.heartbeatAt = new Date().toISOString();
          const temp = `${path}.${process.pid}.tmp`;
          const file = await open(temp, "w", 0o600);
          try { await file.writeFile(`${JSON.stringify(record)}\n`); await file.sync(); } finally { await file.close(); }
          const { rename } = await import("node:fs/promises"); await rename(temp, path);
        },
        release: async () => {
          if (released) return;
          released = true;
          try {
            const current = JSON.parse(await readFile(path, "utf8")) as LockRecord;
            if (current.pid === process.pid && current.startedAt === record.startedAt) await unlink(path);
          } catch { /* already removed or replaced */ }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let current: LockRecord | undefined;
      try { current = JSON.parse(await readFile(path, "utf8")) as LockRecord; } catch { /* incomplete lock: do not steal it */ }
      if (!current || processIsAlive(current.pid)) return undefined;
      try { await unlink(path); } catch { return undefined; }
    }
  }
  return undefined;
}
