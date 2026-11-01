import type { ChatMessage, ModelInfo } from "./openai-compatible";
import { ProviderError } from "./openai-compatible";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export interface NativeProviderConfig { apiKey: string; model: string; fetch?: FetchLike }

async function* readSse(response: Response, signal?: AbortSignal): AsyncGenerator<string> {
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    let detail = body;
    try { detail = (JSON.parse(body) as { error?: { message?: string }; message?: string }).error?.message ?? (JSON.parse(body) as { message?: string }).message ?? body; } catch {}
    throw new ProviderError(detail || `Provider request failed with HTTP ${response.status}`, response.status);
  }
  if (!response.body) throw new ProviderError("Provider returned an empty response stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (data && data !== "[DONE]") yield data;
      }
      if (done) {
        if (buffer.trim()) {
          const data = buffer.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
          if (data && data !== "[DONE]") yield data;
        }
        break;
      }
    }
  } finally {
    if (signal?.aborted) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function createAnthropicClient(config: NativeProviderConfig) {
  const request = config.fetch ?? fetch;
  const headers = { "content-type": "application/json", "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" };
  return {
    async listModels(): Promise<ModelInfo[]> {
      const response = await request("https://api.anthropic.com/v1/models?limit=1000", { headers });
      if (!response.ok) { const body = await response.text(); throw new ProviderError(body || `HTTP ${response.status}`, response.status); }
      const payload = await response.json() as { data?: Array<{ id: string }> };
      return (payload.data ?? []).map((item) => ({ id: item.id }));
    },
    async *streamChat(messages: ChatMessage[], signal?: AbortSignal): AsyncGenerator<string> {
      const system = messages.filter((item) => item.role === "system").map((item) => item.content).join("\n\n");
      const conversation = messages.filter((item) => item.role !== "system").map((item) => ({ role: item.role === "assistant" ? "assistant" : "user", content: item.content }));
      const response = await request("https://api.anthropic.com/v1/messages", { method: "POST", headers: { ...headers, accept: "text/event-stream" }, body: JSON.stringify({ model: config.model, max_tokens: 2048, ...(system ? { system } : {}), messages: conversation, stream: true }), signal });
      for await (const data of readSse(response, signal)) {
        let event: { type?: string; delta?: { type?: string; text?: string }; error?: { message?: string } };
        try { event = JSON.parse(data) as typeof event; } catch { throw new ProviderError("Anthropic sent invalid streaming data."); }
        if (event.type === "error") throw new ProviderError(event.error?.message ?? "Anthropic request failed.");
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) yield event.delta.text;
      }
    },
  };
}

export function createGeminiClient(config: NativeProviderConfig) {
  const request = config.fetch ?? fetch;
  return {
    async listModels(): Promise<ModelInfo[]> {
      const response = await request(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(config.apiKey)}&pageSize=1000`);
      if (!response.ok) { const body = await response.text(); throw new ProviderError(body || `HTTP ${response.status}`, response.status); }
      const payload = await response.json() as { models?: Array<{ name: string; supportedGenerationMethods?: string[] }> };
      return (payload.models ?? []).filter((item) => !item.supportedGenerationMethods || item.supportedGenerationMethods.includes("generateContent")).map((item) => ({ id: item.name.replace(/^models\//, "") }));
    },
    async *streamChat(messages: ChatMessage[], signal?: AbortSignal): AsyncGenerator<string> {
      const system = messages.filter((item) => item.role === "system").map((item) => item.content).join("\n\n");
      const contents = messages.filter((item) => item.role !== "system").map((item) => ({ role: item.role === "assistant" ? "model" : "user", parts: [{ text: item.content }] }));
      const response = await request(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(config.apiKey)}`, { method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream" }, body: JSON.stringify({ ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}), contents, generationConfig: { maxOutputTokens: 2048 } }), signal });
      for await (const data of readSse(response, signal)) {
        let event: { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; error?: { message?: string } };
        try { event = JSON.parse(data) as typeof event; } catch { throw new ProviderError("Gemini sent invalid streaming data."); }
        if (event.error?.message) throw new ProviderError(event.error.message);
        for (const part of event.candidates?.[0]?.content?.parts ?? []) if (part.text) yield part.text;
      }
    },
  };
}
