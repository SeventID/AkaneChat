import type { ChatMessage } from "./providers/openai-compatible";

export type HealthState = "WORKING" | "FAILED" | "UNCHECKED";
export interface ProbeClient { streamChat(messages: ChatMessage[], signal?: AbortSignal): AsyncGenerator<string> }

export async function checkModel(client: ProbeClient, timeoutMs = 12_000): Promise<{ ok: boolean; reason?: string; retryable?: boolean }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Health check timed out.")), timeoutMs);
  try {
    const messages: ChatMessage[] = [{ role: "user", content: "Reply with OK." }];
    const iterator = client.streamChat(messages, controller.signal);
    const first = await iterator.next();
    if (first.done || !first.value.trim()) return { ok: false, reason: "Model returned an empty response.", retryable: false };
    return { ok: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: controller.signal.aborted ? "Health check timed out." : reason, retryable: controller.signal.aborted || shouldFailover(error) };
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

export function shouldFailover(error: unknown): boolean {
  const status = typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status?: unknown }).status) : undefined;
  if (status === 401 || status === 403 || status === 400 || status === 404 || status === 422) return false;
  if (status === 408 || status === 409 || status === 425 || status === 429 || (status !== undefined && status >= 500)) return true;
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return /timeout|timed out|temporar|overload|rate.?limit|unavailable|connection reset|network|fetch failed|socket|econn|503|502|504/.test(message);
}
