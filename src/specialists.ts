export type SpecialistRole = "explorer" | "researcher" | "coder" | "reviewer";

export interface SpecialistAssignment {
  role: SpecialistRole;
  purpose: string;
}

const ROLE_GUIDANCE: Record<SpecialistRole, string[]> = {
  explorer: [
    "SPECIALIST ROLE — EXPLORER",
    "Map the relevant workspace structure and identify only files needed for the stated goal.",
    "Prefer targeted search and small reads; do not modify files. Ignore secrets, .env files, credentials, and generated/vendor directories.",
    "Return concise findings with exact relative paths and distinguish observed facts from hypotheses.",
  ],
  researcher: [
    "SPECIALIST ROLE — RESEARCHER",
    "Identify what must be verified, use only available research capabilities, and distinguish source-backed facts from assumptions.",
    "Do not invent citations, current facts, benchmark results, or external access. Summarize only information actually available in context or tool results.",
  ],
  coder: [
    "SPECIALIST ROLE — CODER",
    "Implement the smallest change that satisfies the goal and matches existing project conventions.",
    "Inspect before editing. Use only approved workspace tools. Never bypass explicit write approval or claim a proposed write was applied.",
    "Avoid unrelated refactors, dependency additions, destructive commands, and edits to secrets or environment files.",
  ],
  reviewer: [
    "SPECIALIST ROLE — REVIEWER",
    "Independently check the proposed result against the goal, constraints, and available evidence.",
    "Look for regressions, security issues, missing edge cases, and unverified claims. Do not modify files; request a focused correction when needed.",
    "Report verified checks separately from checks that could not be run.",
  ],
};

/** Deterministic, low-cost role routing; it never creates extra model calls. */
export function selectSpecialists(goal: string, workspaceEnabled = true): SpecialistAssignment[] {
  const text = goal.toLowerCase();
  const code = /\b(code|coding|repo|repository|file|project|bug|debug|implement|refactor|build|test|program|script|error|crash)\b/.test(text);
  const research = /\b(research|latest|current|compare|evaluate|documentation|docs|benchmark|investigate|find)\b/.test(text);
  const implementation = /\b(implement|fix|repair|write|create|build|refactor|change|update)\b/.test(text);
  const review = /\b(review|audit|test|debug|bug|security|check|verify|evaluate)\b/.test(text);
  const assignments: SpecialistAssignment[] = [];
  if (code && workspaceEnabled) assignments.push({ role: "explorer", purpose: "inspect relevant project context" });
  if (research) assignments.push({ role: "researcher", purpose: "gather and qualify evidence" });
  if (implementation && code && workspaceEnabled) assignments.push({ role: "coder", purpose: "make approved, scoped changes" });
  if (review || implementation || (code && workspaceEnabled)) assignments.push({ role: "reviewer", purpose: "check outcome and evidence" });
  return assignments;
}

export function buildSpecialistInstructions(assignments: SpecialistAssignment[]): string {
  if (!assignments.length) return "SPECIALIST ROUTING: No specialist pass is needed; answer directly.";
  return [
    "SPECIALIST LAYER (sequential role passes, same model and same bounded tool session):",
    "The assignments below are perspectives for this single assistant run, not separate agents or independent model calls.",
    "Apply each role in order. Carry forward only concise findings and evidence; never fabricate a specialist result.",
    "A role does not grant additional tools or permissions. Existing tool allowlists, call budgets, workspace boundaries, and user approval gates remain authoritative.",
    ...assignments.map((item, index) => `${index + 1}. ${item.role.toUpperCase()} — ${item.purpose}\n${ROLE_GUIDANCE[item.role].slice(1).map((line) => `   ${line}`).join("\n")}`),
    "Finish with one integrated response and clearly label completed, verified, blocked, and remaining work.",
  ].join("\n");
}
