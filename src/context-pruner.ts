export interface PrunableMessage {
  role: string;
  content: string | null;
  tool_calls?: Array<{ id: string }>;
  tool_call_id?: string;
}

export interface ContextPruneOptions {
  keepRecentMessages?: number;
  maxCharacters?: number;
  summaryCharacters?: number;
}

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\b(api[_-]?key|token|access[_-]?token|refresh[_-]?token|password)\s*[:=]\s*[^\s,;]+/gi,
];

function safeText(value: string): string {
  let text = value;
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, "[REDACTED]");
  return text.replace(/\s+/g, " ").trim();
}

function messageGroups<T extends PrunableMessage>(messages: T[]): T[][] {
  const groups: T[][] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    const group = [message];
    if (message.role === "assistant" && message.tool_calls?.length) {
      const expected = new Set(message.tool_calls.map((call) => call.id));
      while (index + 1 < messages.length && expected.size > 0) {
        const next = messages[index + 1]!;
        if (next.role !== "tool" || !next.tool_call_id || !expected.has(next.tool_call_id)) break;
        group.push(next);
        expected.delete(next.tool_call_id);
        index++;
      }
    }
    groups.push(group);
  }
  return groups;
}

function renderSummary(groups: PrunableMessage[][], limit: number): string {
  const lines: string[] = [];
  for (const group of groups) {
    const parts = group.map((message) => {
      const label = message.role === "assistant" ? "Assistant" : message.role === "user" ? "User" : message.role === "tool" ? "Tool result" : message.role;
      return `${label}: ${safeText(message.content ?? "[tool call]")}`;
    });
    const line = parts.join(" | ");
    if (!line || line.endsWith(": ")) continue;
    if (lines.join("\n").length + line.length + 1 > limit) break;
    lines.push(line);
  }
  return lines.join("\n");
}

/** Deterministically compresses old context. The caller's original history is never mutated. */
export function pruneContext<T extends PrunableMessage>(
  messages: T[],
  options: ContextPruneOptions = {},
): T[] {
  const keepRecent = Math.max(2, options.keepRecentMessages ?? 10);
  const maxCharacters = Math.max(2_000, options.maxCharacters ?? 24_000);
  const summaryCharacters = Math.max(500, options.summaryCharacters ?? 4_000);
  if (messages.length <= keepRecent && messages.reduce((sum, item) => sum + (item.content?.length ?? 0), 0) <= maxCharacters) return [...messages];

  const groups = messageGroups(messages);
  const system = groups.filter((group) => group.every((item) => item.role === "system"));
  const conversational = groups.filter((group) => !group.every((item) => item.role === "system"));
  const recent: T[][] = [];
  let recentCount = 0;
  for (let index = conversational.length - 1; index >= 0; index--) {
    const group = conversational[index]!;
    if (recentCount >= keepRecent && recent.length > 0) break;
    recent.unshift(group);
    recentCount += group.length;
  }
  const older = conversational.slice(0, conversational.length - recent.length);
  const fixed = [...system.flat(), ...recent.flat()];
  const fixedCharacters = fixed.reduce((sum, item) => sum + (item.content?.length ?? 0), 0);
  if (older.length === 0 && fixedCharacters <= maxCharacters) return [...fixed];

  const summary = renderSummary(older, summaryCharacters);
  const summaryMessage = {
    role: "system",
    content: `Earlier conversation summary (extractive; may omit details):\n${summary || "Older messages omitted to fit context."}`,
  } as T;
  const output = [...system.flat(), summaryMessage, ...recent.flat()];
  // Keep the newest user request even when a single message exceeds the budget.
  return output;
}
