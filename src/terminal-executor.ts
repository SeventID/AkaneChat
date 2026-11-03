import { spawn } from "node:child_process";

export const TERMINAL_CHECKS = ["typecheck", "test", "build", "diff"] as const;
export type TerminalCheck = (typeof TERMINAL_CHECKS)[number];
export interface TerminalResult {
  check: TerminalCheck;
  command: string;
  exitCode: number;
  timedOut: boolean;
  output: string;
  durationMs: number;
}

const COMMANDS: Record<TerminalCheck, { executable: string; args: string[]; label: string }> = {
  typecheck: { executable: "bun", args: ["run", "typecheck"], label: "bun run typecheck" },
  test: { executable: "bun", args: ["test", "tests/*.test.ts"], label: "bun test tests/*.test.ts" },
  build: { executable: "bun", args: ["run", "build"], label: "bun run build" },
  diff: { executable: "git", args: ["diff", "--check"], label: "git diff --check" },
};
const MAX_OUTPUT = 32_000;
const TIMEOUT_MS = 120_000;

/** Runs only a named, fixed project check. No user/AI-provided shell or arguments are accepted. */
export async function runTerminalCheck(workspace: string, check: string): Promise<TerminalResult> {
  if (!Object.hasOwn(COMMANDS, check)) throw new Error(`Unsupported check. Choose: ${TERMINAL_CHECKS.join(", " )}.`);
  const selected = COMMANDS[check as TerminalCheck];
  const started = Date.now();
  return await new Promise((resolve, reject) => {
    const child = spawn(selected.executable, selected.args, {
      cwd: workspace,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "", CI: "1", FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      // Isolate the command tree so timeout cleanup can terminate descendants too.
      detached: process.platform !== "win32",
    });
    let output = "";
    let timedOut = false;
    let settled = false;
    const append = (chunk: Buffer) => {
      if (output.length < MAX_OUTPUT) output += chunk.toString("utf8").slice(0, MAX_OUTPUT - output.length);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const signalProcessTree = (signal: NodeJS.Signals) => {
      if (process.platform !== "win32" && child.pid) {
        try { process.kill(-child.pid, signal); } catch { /* Process may already have exited. */ }
      } else {
        try { child.kill(signal); } catch { /* Process may already have exited. */ }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      signalProcessTree("SIGTERM");
      killTimer = setTimeout(() => signalProcessTree("SIGKILL"), 5_000);
    }, TIMEOUT_MS);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(new Error(`Could not start ${selected.label}: ${error.message}`));
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ check: check as TerminalCheck, command: selected.label, exitCode: code ?? 1, timedOut, output, durationMs: Date.now() - started });
    });
  });
}
