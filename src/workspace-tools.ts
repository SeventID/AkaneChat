import { lstat, readdir, readFile, realpath, stat, mkdir, open } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";
import { isAbsolute, relative, resolve, sep } from "node:path";

const BLOCKED_NAMES = new Set([
  ".env", ".env.local", ".env.production", ".env.development", ".git", ".ssh",
  ".gnupg", ".npmrc", ".pypirc", ".netrc", "authorized_keys", "known_hosts",
  "node_modules", "vendor", "dist", "build", "coverage", ".cache",
]);
const SECRET_FILE = /(^|\.)(id_rsa|id_ed25519|id_ecdsa|credentials?|secrets?)(\.|$)|\.(pem|key|p12|pfx)$/i;
const MAX_FILE_BYTES = 256_000;
const MAX_RESULTS = 100;

export type WorkspaceToolName = "list_files" | "read_file" | "search_files" | "write_file";
export interface WorkspaceToolCall { name: WorkspaceToolName; arguments: Record<string, unknown> }
export interface PendingWorkspaceWrite { path: string; content: string; existed: boolean }

function isBlockedPath(path: string): boolean {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.some((part) => BLOCKED_NAMES.has(part) || /^\.env(?:$|\.)/i.test(part) || SECRET_FILE.test(part));
}

export async function safeWorkspacePath(rootPath: string, requested: string): Promise<string> {
  if (!requested.trim() || isAbsolute(requested)) throw new Error("Use a relative path inside the selected workspace.");
  const root = await realpath(rootPath);
  const target = resolve(root, requested);
  const rel = relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    if (!rel) return root;
    throw new Error("Path is outside the selected workspace.");
  }
  if (isBlockedPath(rel)) throw new Error("Access to sensitive or generated paths is blocked.");
  let current = root;
  for (const part of rel.split(sep)) {
    current = resolve(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error("Symbolic links are not allowed in workspace paths.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  // Resolve existing targets and parents to guard against path escapes.
  let existing = target;
  while (true) {
    try {
      const actual = await realpath(existing);
      const actualRel = relative(root, actual);
      if (actualRel === ".." || actualRel.startsWith(`..${sep}`) || isAbsolute(actualRel)) {
        throw new Error("Resolved path is outside the selected workspace.");
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = resolve(existing, "..");
      if (parent === existing) throw error;
      existing = parent;
    }
  }
  return target;
}

export async function listWorkspaceFiles(root: string, directory = "."): Promise<string[]> {
  const target = await safeWorkspacePath(root, directory);
  const info = await stat(target);
  if (!info.isDirectory()) throw new Error("Requested path is not a directory.");
  const results: string[] = [];
  async function walk(current: string, prefix: string, depth: number): Promise<void> {
    if (depth > 4 || results.length >= MAX_RESULTS) return;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (isBlockedPath(rel) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(resolve(current, entry.name), rel, depth + 1);
      else if (entry.isFile()) results.push(rel);
      if (results.length >= MAX_RESULTS) break;
    }
  }
  await walk(target, directory === "." ? "" : directory, 0);
  return results;
}

export async function readWorkspaceText(root: string, path: string): Promise<string> {
  const target = await safeWorkspacePath(root, path);
  const info = await lstat(target);
  if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error(`File must be regular text and no larger than ${MAX_FILE_BYTES} bytes.`);
  const data = await readFile(target);
  if (data.includes(0)) throw new Error("Binary files are not readable by the workspace agent.");
  return data.toString("utf8");
}

export async function searchWorkspaceText(root: string, query: string): Promise<string[]> {
  if (!query.trim() || query.length > 200) throw new Error("Search query must be 1–200 characters.");
  const files = await listWorkspaceFiles(root);
  const matches: string[] = [];
  for (const path of files) {
    try {
      const content = await readWorkspaceText(root, path);
      const lines = content.split(/\r?\n/);
      lines.forEach((line, index) => {
        if (line.toLowerCase().includes(query.toLowerCase()) && matches.length < MAX_RESULTS) {
          matches.push(`${path}:${index + 1}: ${line.slice(0, 240)}`);
        }
      });
    } catch { /* Skip binary, oversized, or unreadable files. */ }
    if (matches.length >= MAX_RESULTS) break;
  }
  return matches;
}

export async function prepareWorkspaceWrite(root: string, path: string, content: string): Promise<PendingWorkspaceWrite> {
  if (typeof content !== "string" || content.length > MAX_FILE_BYTES) throw new Error(`New content must be text and no larger than ${MAX_FILE_BYTES} bytes.`);
  const target = await safeWorkspacePath(root, path);
  let existed = false;
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error("Target is not a regular file or exceeds the write limit.");
    existed = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { path, content, existed };
}

export function getUnsupportedWorkspaceTool(error: unknown): WorkspaceToolName | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/(?:try\s+)?disabl(?:e|ing)\s+[\'\"]?(list_files|read_file|search_files|write_file)[\'\"]?/i);
  return match?.[1]?.toLowerCase() as WorkspaceToolName | undefined;
}

export function getAvailableWorkspaceToolDefinitions(disabled: ReadonlySet<string>): (typeof WORKSPACE_TOOL_DEFINITIONS)[number][] {
  return WORKSPACE_TOOL_DEFINITIONS.filter((definition) => !disabled.has(definition.function.name));
}

export const WORKSPACE_TOOL_DEFINITIONS = [
  { type: "function", function: { name: "list_files", description: "List files in the selected workspace. Sensitive, generated, and dependency paths are excluded.", parameters: { type: "object", properties: { directory: { type: "string", description: "Relative directory, default ." } }, additionalProperties: false } } },
  { type: "function", function: { name: "read_file", description: "Read a UTF-8 text file in the selected workspace. Sensitive and binary files are blocked.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } } },
  { type: "function", function: { name: "search_files", description: "Search text in readable files in the selected workspace.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } } },
  { type: "function", function: { name: "write_file", description: "Propose creating or replacing a UTF-8 text file. The application will ask the user for confirmation before writing.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false } } },
] as const;

export async function executeWorkspaceReadTool(root: string, call: WorkspaceToolCall): Promise<string | PendingWorkspaceWrite> {
  switch (call.name) {
    case "list_files": {
      const directory = typeof call.arguments.directory === "string" ? call.arguments.directory : ".";
      const files = await listWorkspaceFiles(root, directory);
      return files.length ? files.join("\n") : "No readable files found.";
    }
    case "read_file": {
      if (typeof call.arguments.path !== "string") throw new Error("path is required.");
      return await readWorkspaceText(root, call.arguments.path);
    }
    case "search_files": {
      if (typeof call.arguments.query !== "string") throw new Error("query is required.");
      const matches = await searchWorkspaceText(root, call.arguments.query);
      return matches.length ? matches.join("\n") : "No matches found.";
    }
    case "write_file": {
      if (typeof call.arguments.path !== "string" || typeof call.arguments.content !== "string") throw new Error("path and content are required.");
      return await prepareWorkspaceWrite(root, call.arguments.path, call.arguments.content);
    }
  }
}

export async function applyWorkspaceWrite(root: string, pending: PendingWorkspaceWrite): Promise<void> {
  const target = await safeWorkspacePath(root, pending.path);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  // Revalidate after directory creation and refuse a symlink swap at the final path.
  await safeWorkspacePath(root, pending.path);
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | (pending.existed ? constants.O_TRUNC : constants.O_EXCL);
  const handle = await open(target, flags, 0o600);
  try {
    await handle.writeFile(pending.content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}
