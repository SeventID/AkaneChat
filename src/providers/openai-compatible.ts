export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ProviderConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  fetch?: FetchLike;
}

export interface ModelInfo {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
}

interface ModelsResponse {
  data?: ModelInfo[];
}

interface ChatCompletionChunk {
  choices?: Array<{
    delta?: { content?: string | Array<{ type?: string; text?: string }> };
    finish_reason?: string | null;
  }>;
  error?: { message?: string };
}

export class ProviderError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "ProviderError";
  }
}

function endpoint(baseUrl: string, path: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new ProviderError("Invalid provider URL. Use an http:// or https:// URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ProviderError("Provider URL must use http:// or https://.");
  }
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

export function createOpenAICompatibleClient(config: ProviderConfig) {
  const request: FetchLike = config.fetch ?? (fetch as FetchLike);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;

  async function checkResponse(response: Response): Promise<void> {
    if (response.ok) return;
    const body = await response.text().catch(() => "");
    let detail = body;
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string }; message?: string };
      detail = parsed.error?.message ?? parsed.message ?? body;
    } catch {
      // Keep the original response body when it is not JSON.
    }
    throw new ProviderError(
      detail.trim() || `Provider request failed with HTTP ${response.status}`,
      response.status,
    );
  }

  return {
    async listModels(): Promise<ModelInfo[]> {
      const response = await request(endpoint(config.baseUrl, "/models"), {
        method: "GET",
        headers,
      });
      await checkResponse(response);
      const payload = (await response.json()) as ModelsResponse;
      return Array.isArray(payload.data) ? payload.data : [];
    },

    async *streamChat(messages: ChatMessage[], signal?: AbortSignal): AsyncGenerator<string> {
      if (!config.model.trim()) throw new ProviderError("Choose a model before sending a message.");
      if (messages.length === 0) throw new ProviderError("A conversation must contain at least one message.");

      const response = await request(endpoint(config.baseUrl, "/chat/completions"), {
        method: "POST",
        headers: { ...headers, accept: "text/event-stream" },
        body: JSON.stringify({ model: config.model, messages, stream: true }),
        signal,
      });
      await checkResponse(response);
      if (!response.body) throw new ProviderError("Provider returned an empty response stream.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finished = false;

      const decodeFrame = (frame: string): string[] => {
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (!data) return [];
        if (data.trim() === "[DONE]") {
          finished = true;
          return [];
        }
        let chunk: ChatCompletionChunk;
        try {
          chunk = JSON.parse(data) as ChatCompletionChunk;
        } catch {
          throw new ProviderError("Provider sent an invalid streaming response.");
        }
        if (chunk.error?.message) throw new ProviderError(chunk.error.message);
        const content = chunk.choices?.[0]?.delta?.content;
        if (typeof content === "string" && content) return [content];
        if (Array.isArray(content)) return content.flatMap((part) => part.text ? [part.text] : []);
        return [];
      };

      try {
        while (!finished) {
          const { value, done } = await reader.read();
          buffer += decoder.decode(value, { stream: !done });
          const frames = buffer.split(/\r?\n\r?\n/);
          buffer = frames.pop() ?? "";

          for (const frame of frames) {
            for (const text of decodeFrame(frame)) yield text;
            if (finished) break;
          }
          if (done) {
            // SSE permits the final event to end at EOF without a blank separator.
            if (!finished && buffer.trim()) {
              for (const text of decodeFrame(buffer)) yield text;
            }
            break;
          }
        }
      } finally {
        if (signal?.aborted) await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    },
  };
}
