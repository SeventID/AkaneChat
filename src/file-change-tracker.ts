import { createHash } from "node:crypto";
import { listWorkspaceFiles, readWorkspaceText } from "./workspace-tools";

export interface FileFingerprint { path: string; sha256: string }
export interface FileChange { path: string; change: "created" | "modified" | "deleted"; before?: string; after?: string }
const MAX_TRACKED_FILES = 300;

/** Snapshot only readable workspace files; sensitive/generated paths inherit workspace-tools exclusions. */
export async function captureWorkspaceSnapshot(root: string): Promise<FileFingerprint[]> {
  const paths = (await listWorkspaceFiles(root)).slice(0, MAX_TRACKED_FILES);
  const result: FileFingerprint[] = [];
  for (const path of paths) {
    try {
      const content = await readWorkspaceText(root, path);
      result.push({ path, sha256: createHash("sha256").update(content).digest("hex") });
    } catch { /* A file may be unreadable or change during snapshot; omit it. */ }
  }
  return result;
}

export function diffWorkspaceSnapshots(before: readonly FileFingerprint[], after: readonly FileFingerprint[]): FileChange[] {
  const oldFiles = new Map(before.map((item) => [item.path, item.sha256]));
  const newFiles = new Map(after.map((item) => [item.path, item.sha256]));
  const changes: FileChange[] = [];
  for (const [path, hash] of newFiles) {
    const previous = oldFiles.get(path);
    if (previous === undefined) changes.push({ path, change: "created", after: hash });
    else if (previous !== hash) changes.push({ path, change: "modified", before: previous, after: hash });
  }
  for (const [path, hash] of oldFiles) if (!newFiles.has(path)) changes.push({ path, change: "deleted", before: hash });
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}
