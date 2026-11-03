import type { FileChange } from "./file-change-tracker";
import type { TaskEvidence } from "./storage/tasks";

export interface CompletionGateInput { changes: readonly FileChange[]; evidence: readonly TaskEvidence[]; requiresCodeChange: boolean }
export interface CompletionGateResult { verdict: "eligible_for_review" | "blocked" | "insufficient_evidence"; reasons: string[] }

/** Deterministic gate: it never marks a task complete; it only decides whether evidence is reviewable. */
export function evaluateCompletionGate(input: CompletionGateInput): CompletionGateResult {
  const reasons: string[] = [];
  const failed = input.evidence.filter((item) => item.status === "failed" || item.status === "rejected" || item.status === "blocked");
  if (failed.length) reasons.push(`${failed.length} tool action(s) failed, rejected, or blocked.`);
  const writes = input.evidence.filter((item) => item.tool === "write_file" && item.status === "succeeded");
  if (input.requiresCodeChange && !input.changes.length) reasons.push("No independently observed workspace file changes.");
  if (input.requiresCodeChange && !writes.length) reasons.push("No successful write_file evidence was recorded.");
  if (reasons.some((reason) => reason.includes("failed, rejected, or blocked"))) return { verdict: "blocked", reasons };
  if (reasons.length) return { verdict: "insufficient_evidence", reasons };
  if (!input.evidence.length) return { verdict: "insufficient_evidence", reasons: ["No tool evidence was recorded."] };
  return { verdict: "eligible_for_review", reasons: ["Observed file changes and tool evidence are available; human/reviewer confirmation is still required."] };
}
