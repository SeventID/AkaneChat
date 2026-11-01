import { realpath, lstat, readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, dirname } from "node:path";

export interface WorkspaceEntry { name: string; path: string; directory: boolean }

export async function listWorkspaceDirectories(path: string): Promise<WorkspaceEntry[]> {
  const root = await realpath(path);
  const entries = await readdir(root, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => ({ name: entry.name, path: resolve(root, entry.name), directory: true }));
}

export async function resolveWorkspacePath(rootPath: string, requestedPath: string): Promise<string> {
  const root = await realpath(rootPath);
  const target = resolve(root, requestedPath);
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Path is outside the selected workspace.");
  let current = root;
  for (const segment of rel.split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error("Symbolic links are not allowed in workspace paths.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return target;
}

export async function readWorkspaceFile(root: string, path: string, maxBytes = 256_000): Promise<string> {
  const target = await resolveWorkspacePath(root, path);
  const info = await lstat(target);
  if (!info.isFile() || info.size > maxBytes) throw new Error("File is not regular or exceeds the read limit.");
  return readFile(target, "utf8");
}

export async function writeWorkspaceFile(root: string, path: string, content: string): Promise<void> {
  const target = await resolveWorkspacePath(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, { flag: "w", mode: 0o600 });
}
