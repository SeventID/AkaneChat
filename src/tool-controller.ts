import { createToolCallGuard, type ToolCallDecision } from "./agent-core";
import { createEvidenceLedger, type EvidenceStatus } from "./evidence-engine";

const ALLOWED_WORKSPACE_TOOLS = new Set(["list_files", "read_file", "search_files", "write_file"]);

/** Central policy boundary for the currently supported workspace tools. */
export function createToolController(options: { maxCalls?: number; maxRepeatedCalls?: number } = {}) {
  const guard = createToolCallGuard(options);
  const evidence = createEvidenceLedger();
  return {
    check(name: string, args: Record<string, unknown>): ToolCallDecision {
      if (!ALLOWED_WORKSPACE_TOOLS.has(name)) {
        const stats = guard.stats();
        evidence.record(name, "blocked", "Tool is not in the workspace allowlist.");
        return { allowed: false, reason: "Unknown or disallowed tool.", totalCalls: stats.totalCalls, repeatedCalls: 0 };
      }
      const decision = guard.check(name, args);
      if (!decision.allowed) evidence.record(name, "blocked", decision.reason ?? "Blocked by tool-call policy.");
      return decision;
    },
    record(name: string, status: EvidenceStatus, summary: string): void { evidence.record(name, status, summary); },
    evidence,
    stats() { return { ...guard.stats(), evidence: evidence.stats() }; },
  };
}
