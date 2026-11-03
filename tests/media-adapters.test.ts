import { describe, expect, test } from "bun:test";
import { createAsyncVideoAdapter, createOpenAIImageAdapter, routeMediaAdapter } from "../src/media-adapters";

describe("media adapters", () => {
  test("routes only to a matching configured adapter", () => {
    const image = createOpenAIImageAdapter({ id: "img", capability: "image_generation", endpoint: "https://example.test/v1/images/generations", apiKey: "x" });
    const video = createAsyncVideoAdapter({ id: "vid", capability: "video_generation", endpoint: "https://example.test/v1/videos", apiKey: "x" });
    expect(routeMediaAdapter([image, video], "video_generation").selected?.id).toBe("vid");
    expect(routeMediaAdapter([image], "video_generation").selected).toBeUndefined();
  });
  test("posts image request and returns provider output", async () => {
    let body = "";
    const adapter = createOpenAIImageAdapter({ id: "test", capability: "image_generation", endpoint: "https://example.test/v1/images/generations", apiKey: "secret" }, async (_input, init) => { body = String(init?.body); return Response.json({ data: [{ url: "https://cdn.example.test/image.png" }] }); });
    const result = await adapter.generate({ prompt: "a red cat" });
    expect(JSON.parse(body).prompt).toBe("a red cat");
    expect(result.url).toBe("https://cdn.example.test/image.png");
  });
  test("rejects insecure remote endpoints", () => {
    expect(() => createOpenAIImageAdapter({ id: "bad", capability: "image_generation", endpoint: "http://example.test/generate", apiKey: "x" })).toThrow();
  });
});

test("media fallback tries the next compatible adapter after failure", async () => {
  const { generateWithMediaFallback } = await import("../src/media-adapters");
  const first = { id: "first", capability: "image_generation" as const, generate: async () => { throw new Error("provider down"); } };
  const second = { id: "second", capability: "image_generation" as const, generate: async () => ({ provider: "second", url: "https://cdn.example.test/ok.png" }) };
  const result = await generateWithMediaFallback([first, second], "image_generation", { prompt: "test" });
  expect(result.provider).toBe("second");
  expect(result.attempts).toHaveLength(1);
  expect(result.attempts[0]?.adapter).toBe("first");
});

test("media fallback never substitutes a chat model", async () => {
  const { generateWithMediaFallback } = await import("../src/media-adapters");
  await expect(generateWithMediaFallback([], "video_generation", { prompt: "test" })).rejects.toThrow("No configured adapter");
});

test("media fallback stops on non-retryable provider errors", async () => {
  const { generateWithMediaFallback, MediaProviderError } = await import("../src/media-adapters");
  let secondCalled = false;
  const first = { id: "bad-request", capability: "image_generation" as const, generate: async () => { throw new MediaProviderError("invalid prompt", 400); } };
  const second = { id: "backup", capability: "image_generation" as const, generate: async () => { secondCalled = true; return { provider: "backup" }; } };
  await expect(generateWithMediaFallback([first, second], "image_generation", { prompt: "test" })).rejects.toThrow("invalid prompt");
  expect(secondCalled).toBe(false);
});

test("video adapter polls a same-origin status URL until the output is ready", async () => {
  const { createAsyncVideoAdapter } = await import("../src/media-adapters");
  let calls = 0;
  const adapter = createAsyncVideoAdapter({ id: "video", capability: "video_generation", endpoint: "https://video.example.test/generate", apiKey: "secret" }, async (input) => {
    calls++;
    if (calls === 1) return new Response(JSON.stringify({ id: "job-1", status_url: "/jobs/1" }), { status: 200 });
    expect(String(input)).toBe("https://video.example.test/jobs/1");
    return new Response(JSON.stringify({ status: "completed", url: "https://cdn.example.test/video.mp4" }), { status: 200 });
  }, { intervalMs: 250, maxWaitMs: 1000 });
  const result = await adapter.generate({ prompt: "test" });
  expect(result.url).toBe("https://cdn.example.test/video.mp4");
  expect(result.operationId).toBe("job-1");
  expect(calls).toBe(2);
});

test("video adapter rejects cross-origin status polling URLs", async () => {
  const { createAsyncVideoAdapter } = await import("../src/media-adapters");
  const adapter = createAsyncVideoAdapter({ id: "video", capability: "video_generation", endpoint: "https://video.example.test/generate", apiKey: "secret" }, async () => new Response(JSON.stringify({ id: "job-1", status_url: "https://evil.example.test/jobs/1" }), { status: 200 }), { maxWaitMs: 1000 });
  await expect(adapter.generate({ prompt: "test" })).rejects.toThrow("configured HTTPS origin");
});

test("video adapter stops polling promptly when the caller aborts", async () => {
  const { createAsyncVideoAdapter } = await import("../src/media-adapters");
  const controller = new AbortController();
  let calls = 0;
  const adapter = createAsyncVideoAdapter({ id: "video", capability: "video_generation", endpoint: "https://video.example.test/generate", apiKey: "secret" }, async () => {
    calls++;
    return new Response(JSON.stringify({ id: "job-1", status_url: "/jobs/1" }), { status: 200 });
  }, { intervalMs: 15000, maxWaitMs: 30000 });
  const pending = adapter.generate({ prompt: "test", signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await expect(pending).rejects.toThrow("aborted");
  expect(calls).toBe(1);
});

test("video adapter surfaces provider-declared generation failures", async () => {
  const { createAsyncVideoAdapter } = await import("../src/media-adapters");
  let calls = 0;
  const adapter = createAsyncVideoAdapter({ id: "video", capability: "video_generation", endpoint: "https://video.example.test/generate", apiKey: "secret" }, async () => {
    calls++;
    if (calls === 1) return new Response(JSON.stringify({ id: "job-1", status_url: "/jobs/1" }), { status: 200 });
    return new Response(JSON.stringify({ status: "failed", error: { message: "Content rejected" } }), { status: 200 });
  }, { intervalMs: 250, maxWaitMs: 1000 });
  await expect(adapter.generate({ prompt: "test" })).rejects.toThrow("Content rejected");
  expect(calls).toBe(2);
});


test("video adapter marks accepted operations pending when no output URL is ready", async () => {
  const adapter = createAsyncVideoAdapter({ id: "video", capability: "video_generation", endpoint: "https://video.example.test/generate", apiKey: "secret" }, async () => Response.json({ id: "job-pending" }), { maxWaitMs: 0 });
  const result = await adapter.generate({ prompt: "test" });
  expect(result.operationId).toBe("job-pending");
  expect(result.pending).toBe(true);
  expect(result.url).toBeUndefined();
});

test("image adapter reports image-specific cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  const adapter = createOpenAIImageAdapter({ id: "image", capability: "image_generation", endpoint: "https://image.example.test/generate", apiKey: "secret" }, async () => { throw new Error("fetch should not run"); });
  await expect(adapter.generate({ prompt: "test", signal: controller.signal })).rejects.toThrow("Image generation aborted");
});
