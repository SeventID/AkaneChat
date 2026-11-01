import { describe, expect, test } from "bun:test";
import { createAnthropicClient, createGeminiClient } from "../src/providers/native";

function streamResponse(...events: string[]): Response {
  return new Response(new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(new TextEncoder().encode(`data: ${event}\n\n`));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("native provider adapters", () => {
  test("Anthropic maps system messages and streams text deltas", async () => {
    let requestBody = "";
    const client = createAnthropicClient({ apiKey: "test-key", model: "claude-test", fetch: async (_url, init) => {
      requestBody = String(init?.body);
      return streamResponse(
        JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "hello" } }),
        JSON.stringify({ type: "message_stop" }),
      );
    } });
    const chunks: string[] = [];
    for await (const chunk of client.streamChat([{ role: "system", content: "Be concise" }, { role: "user", content: "Hi" }])) chunks.push(chunk);
    expect(chunks.join("")).toBe("hello");
    expect(JSON.parse(requestBody)).toMatchObject({ system: "Be concise", model: "claude-test", stream: true });
  });

  test("Gemini maps assistant role to model and streams candidate text", async () => {
    let requestBody = "";
    const client = createGeminiClient({ apiKey: "test-key", model: "gemini-test", fetch: async (_url, init) => {
      requestBody = String(init?.body);
      return streamResponse(JSON.stringify({ candidates: [{ content: { parts: [{ text: "world" }] } }] }));
    } });
    const chunks: string[] = [];
    for await (const chunk of client.streamChat([{ role: "user", content: "Hi" }, { role: "assistant", content: "Hello" }])) chunks.push(chunk);
    expect(chunks.join("")).toBe("world");
    expect(JSON.parse(requestBody).contents[1].role).toBe("model");
  });

  test("native adapters surface provider HTTP failures", async () => {
    const client = createAnthropicClient({ apiKey: "test-key", model: "claude-test", fetch: async () => new Response('{"error":{"message":"bad key"}}', { status: 401 }) });
    await expect(async () => {
      for await (const _chunk of client.streamChat([{ role: "user", content: "Hi" }])) { /* consume */ }
    }).toThrow("bad key");
  });
});
