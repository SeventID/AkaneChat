export type EvidenceStatus = "succeeded" | "failed" | "rejected" | "blocked";

export interface ToolEvidence {
  tool: string;
  status: EvidenceStatus;
  summary: string;
  recordedAt: number;
}

const MAX_EVIDENCE = 40;
const MAX_SUMMARY = 500;
const SECRET_PATTERNS = [
  /\b(sk-[A-Za-z0-9_-]{12,})\b/g,
  /\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g,
  /\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi,
  /((?:api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s,;]+/gi,
];

export function sanitizeEvidenceSummary(value: string): string {
  let result = value.replace(/[\r\n\t]+/g, " ").trim();
  for (const pattern of SECRET_PATTERNS) result = result.replace(pattern, (_match, prefix?: string) => `${prefix ?? ""}[REDACTED]`);
  return result.slice(0, MAX_SUMMARY);
}

/** Per-response, bounded evidence ledger. It stores summaries, never raw tool payloads. */
export function createEvidenceLedger() {
  const entries: ToolEvidence[] = [];
  return {
    record(tool: string, status: EvidenceStatus, summary: string): void {
      entries.push({ tool, status, summary: sanitizeEvidenceSummary(summary), recordedAt: Date.now() });
      if (entries.length > MAX_EVIDENCE) entries.shift();
    },
    list(): readonly ToolEvidence[] { return entries.map((entry) => ({ ...entry })); },
    hasSuccessful(tool: string): boolean { return entries.some((entry) => entry.tool === tool && entry.status === "succeeded"); },
    summary(): string {
      if (!entries.length) return "No tool evidence was recorded in this response.";
      return ["TOOL EVIDENCE (use this to ground completion claims):", ...entries.map((entry, index) => `${index + 1}. ${entry.tool}: ${entry.status} — ${entry.summary}`)].join("\n");
    },
    stats() {
      return { total: entries.length, succeeded: entries.filter((entry) => entry.status === "succeeded").length, failed: entries.filter((entry) => entry.status === "failed").length, rejected: entries.filter((entry) => entry.status === "rejected").length, blocked: entries.filter((entry) => entry.status === "blocked").length };
    },
  };
}
