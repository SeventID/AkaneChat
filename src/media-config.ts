import { createAsyncVideoAdapter, createOpenAIImageAdapter, type MediaAdapter } from "./media-adapters";

/** Reads named environment variables only. Credentials are never persisted in settings. */
export function loadMediaAdapters(env: Record<string, string | undefined> = process.env): MediaAdapter[] {
  const adapters: MediaAdapter[] = [];
  const register = (kind: "IMAGE" | "VIDEO", slot: "PRIMARY" | "FALLBACK") => {
    const prefix = `AKANECHAT_${kind}${slot === "FALLBACK" ? "_FALLBACK" : ""}`;
    const endpoint = env[`${prefix}_ENDPOINT`]?.trim();
    const apiKey = env[`${prefix}_API_KEY`]?.trim();
    if (!endpoint || !apiKey) return;
    const id = env[`${prefix}_PROVIDER_ID`]?.trim() || `${kind.toLowerCase()}-${slot.toLowerCase()}`;
    const model = env[`${prefix}_MODEL`]?.trim() || undefined;
    adapters.push(kind === "IMAGE"
      ? createOpenAIImageAdapter({ id, capability: "image_generation", endpoint, apiKey, model })
      : createAsyncVideoAdapter({ id, capability: "video_generation", endpoint, apiKey, model }, fetch, {
          intervalMs: Number(env[`${prefix}_POLL_INTERVAL_MS`]) || 3000,
          maxWaitMs: Number(env[`${prefix}_POLL_MAX_MS`]) || 300_000,
        }));
  };
  register("IMAGE", "PRIMARY");
  register("IMAGE", "FALLBACK");
  register("VIDEO", "PRIMARY");
  register("VIDEO", "FALLBACK");
  return adapters;
}
