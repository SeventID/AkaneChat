import type { ModelCapability } from "./capability-router";

export interface MediaAdapterConfig {
  id: string;
  capability: "image_generation" | "video_generation";
  endpoint: string;
  apiKey: string;
  model?: string;
  timeoutMs?: number;
}
export interface MediaGenerationRequest { prompt: string; size?: string; seconds?: number; signal?: AbortSignal }
export interface VideoPollingConfig { intervalMs?: number; maxWaitMs?: number }
export interface GeneratedMedia { url?: string; base64?: string; mimeType?: string; provider: string; operationId?: string; pending?: boolean }
export interface MediaAdapter { id: string; capability: ModelCapability; generate(request: MediaGenerationRequest): Promise<GeneratedMedia> }
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export class MediaProviderError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = "MediaProviderError"; }
  get retryable(): boolean { return this.status === undefined || this.status === 408 || this.status === 429 || this.status >= 500; }
}

function validateEndpoint(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") throw new Error("Media adapter endpoint must use HTTPS (or localhost for development).");
  return url;
}

export function createOpenAIImageAdapter(config: MediaAdapterConfig, fetcher: FetchLike = fetch): MediaAdapter {
  if (config.capability !== "image_generation") throw new Error("OpenAI image adapter only supports image_generation.");
  const endpoint = validateEndpoint(config.endpoint);
  return {
    id: config.id, capability: "image_generation",
    async generate(request) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.max(1000, Math.min(config.timeoutMs ?? 120_000, 300_000)));
      const abort = () => controller.abort();
      if (request.signal?.aborted) controller.abort();
      else request.signal?.addEventListener("abort", abort, { once: true });
      try {
        if (controller.signal.aborted) throw new Error("Image generation aborted.");
        const response = await fetcher(endpoint, { method: "POST", headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ model: config.model ?? "gpt-image-1", prompt: request.prompt, size: request.size ?? "1024x1024", n: 1 }), signal: controller.signal });
        const payload = await response.json().catch(() => ({})) as { data?: Array<{ url?: string; b64_json?: string }>; error?: { message?: string } };
        if (!response.ok) throw new MediaProviderError(payload.error?.message ?? `Image provider failed with HTTP ${response.status}.`, response.status);
        const item = payload.data?.[0];
        if (!item?.url && !item?.b64_json) throw new Error("Image provider returned no image data.");
        if (item.url) { const output = new URL(item.url); if (output.protocol !== "https:") throw new Error("Image provider returned a non-HTTPS output URL."); }
        return { provider: config.id, ...(item.url ? { url: item.url } : {}), ...(item.b64_json ? { base64: item.b64_json, mimeType: "image/png" } : {}) };
      } finally { clearTimeout(timeout); request.signal?.removeEventListener("abort", abort); }
    },
  };
}

export function createAsyncVideoAdapter(config: MediaAdapterConfig, fetcher: FetchLike = fetch, polling: VideoPollingConfig = {}): MediaAdapter {
  if (config.capability !== "video_generation") throw new Error("Video adapter only supports video_generation.");
  const endpoint = validateEndpoint(config.endpoint);
  return {
    id: config.id, capability: "video_generation",
    async generate(request) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.max(1000, Math.min(config.timeoutMs ?? 300_000, 600_000)));
      const abort = () => controller.abort();
      if (request.signal?.aborted) controller.abort();
      else request.signal?.addEventListener("abort", abort, { once: true });
      try {
        if (controller.signal.aborted) throw new Error("Video generation aborted.");
        const response = await fetcher(endpoint, { method: "POST", headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ model: config.model, prompt: request.prompt, duration: request.seconds ?? 5 }), signal: controller.signal });
        const payload = await response.json().catch(() => ({})) as { id?: string; url?: string; output?: { url?: string }; status_url?: string; statusUrl?: string; status?: string; error?: { message?: string } };
        if (!response.ok) throw new MediaProviderError(payload.error?.message ?? `Video provider failed with HTTP ${response.status}.`, response.status);
        let url = payload.url ?? payload.output?.url;
        if (!url && !payload.id) throw new Error("Video provider returned neither an output URL nor an operation ID.");
        if (!url && (payload.status_url || payload.statusUrl)) {
          const statusUrl = new URL(payload.status_url ?? payload.statusUrl!, endpoint);
          if (statusUrl.protocol !== "https:" || statusUrl.origin !== endpoint.origin) throw new Error("Video status URL must use the configured HTTPS origin.");
          const deadline = Date.now() + Math.max(0, Math.min(polling.maxWaitMs ?? 300_000, 600_000));
          while (Date.now() < deadline && !controller.signal.aborted) {
            await new Promise<void>((resolve, reject) => {
              const finish = () => {
                controller.signal.removeEventListener("abort", onAbort);
                resolve();
              };
              const onAbort = () => {
                clearTimeout(timer);
                controller.signal.removeEventListener("abort", onAbort);
                reject(new Error("Video polling aborted."));
              };
              const timer = setTimeout(finish, Math.max(250, Math.min(polling.intervalMs ?? 3000, 15000)));
              if (controller.signal.aborted) onAbort();
              else controller.signal.addEventListener("abort", onAbort, { once: true });
            });
            if (controller.signal.aborted) throw new Error("Video polling aborted.");
            const check = await fetcher(statusUrl, { headers: { authorization: `Bearer ${config.apiKey}` }, signal: controller.signal });
            const state = await check.json().catch(() => ({})) as { status?: string; url?: string; output?: { url?: string }; error?: { message?: string } };
            if (!check.ok) throw new MediaProviderError(state.error?.message ?? `Video status check failed with HTTP ${check.status}.`, check.status);
            url = state.url ?? state.output?.url;
            if (url) break;
            if (["failed", "error", "cancelled", "canceled"].includes((state.status ?? "").toLowerCase())) throw new Error(state.error?.message ?? `Video generation ${state.status}.`);
          }
        }
        if (url && new URL(url).protocol !== "https:") throw new Error("Video provider returned a non-HTTPS output URL.");
        return { provider: config.id, ...(url ? { url } : {}), ...(payload.id ? { operationId: payload.id } : {}), ...(!url && payload.id ? { pending: true } : {}) };
      } finally { clearTimeout(timeout); request.signal?.removeEventListener("abort", abort); }
    },
  };
}

export function routeMediaAdapter(adapters: MediaAdapter[], capability: "image_generation" | "video_generation", preferred?: string) {
  const eligible = adapters.filter((adapter) => adapter.capability === capability);
  const selected = eligible.find((adapter) => adapter.id === preferred) ?? eligible[0];
  return { selected, alternatives: eligible.filter((adapter) => adapter !== selected) };
}

export interface MediaFallbackResult extends GeneratedMedia { attempts: Array<{ adapter: string; error: string }> }

/** Tries configured adapters in preference order; never downgrades to text chat. */
export async function generateWithMediaFallback(
  adapters: MediaAdapter[],
  capability: "image_generation" | "video_generation",
  request: MediaGenerationRequest,
  preferred?: string,
): Promise<MediaFallbackResult> {
  const route = routeMediaAdapter(adapters, capability, preferred);
  const candidates = route.selected ? [route.selected, ...route.alternatives] : [];
  if (!candidates.length) throw new Error(`No configured adapter supports ${capability}.`);
  const attempts: Array<{ adapter: string; error: string }> = [];
  for (const adapter of candidates) {
    try {
      const result = await adapter.generate(request);
      return { ...result, attempts };
    } catch (error) {
      attempts.push({ adapter: adapter.id, error: error instanceof Error ? error.message : String(error) });
      if (request.signal?.aborted) throw error;
      if (error instanceof MediaProviderError && !error.retryable) throw error;
    }
  }
  throw new AggregateError(attempts.map((item) => new Error(`${item.adapter}: ${item.error}`)), `All ${capability} adapters failed (${attempts.length}).`);
}
