import { describe, expect, test } from "bun:test";
import { createOpenAICompatibleClient, ProviderError } from "../src/providers/openai-compatible";

const jsonResponse = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

describe("OpenAI-compatible provider", () => {
  test("lists models from /models", async () => {
    let requestedUrl = "";
    const client = createOpenAICompatibleClient({
      baseUrl: "http://127.0.0.1:20128/v1/",
      model: "test-model",
      fetch: async (input) => {
        requestedUrl = String(input);
        return jsonResponse({ data: [{ id: "test-model", owned_by: "local" }] });
      },
    });
    const models = await client.listModels();
    expect(requestedUrl).toBe("http://127.0.0.1:20128/v1/models");
    expect(models[0]?.id).toBe("test-model");
  });

  test("sends chat requests and yields streamed text", async () => {
    let sentBody: Record<string, unknown> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'data: {"choices":[{"delta":{"content":"Halo"}}]}\n\n' +
          'data: {"choices":[{"delta":{"content":" dunia"}}]}\n\n' +
          "data: [DONE]\n\n",
        ));
        controller.close();
      },
    });
    const client = createOpenAICompatibleClient({
      baseUrl: "http://localhost:1234/v1",
      apiKey: "test-key",
      model: "demo",
      fetch: async (_input, init) => {
        sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key");
        return new Response(stream);
      },
    });
    const parts: string[] = [];
    for await (const part of client.streamChat([{ role: "user", content: "Hai" }])) parts.push(part);
    expect(parts.join("")).toBe("Halo dunia");
    expect(sentBody?.model).toBe("demo");
    expect(sentBody?.stream).toBe(true);
  });

  test("passes an abort signal to the streaming request", async () => {
    let receivedSignal: AbortSignal | null | undefined;
    const controller = new AbortController();
    const client = createOpenAICompatibleClient({
      baseUrl: "http://localhost:1234/v1",
      model: "demo",
      fetch: async (_input, init) => {
        receivedSignal = init?.signal;
        return new Response(new ReadableStream<Uint8Array>({
          start(streamController) {
            streamController.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
          },
        }));
      },
    });
    const iterator = client.streamChat([{ role: "user", content: "Hai" }], controller.signal);
    expect((await iterator.next()).value).toBe("partial");
    expect(receivedSignal).toBe(controller.signal);
    controller.abort();
    await iterator.return("");
  });

  test("surfaces provider HTTP errors", async () => {
    const client = createOpenAICompatibleClient({
      baseUrl: "http://localhost:1234/v1",
      model: "demo",
      fetch: async () => jsonResponse({ error: { message: "Unauthorized" } }, 401),
    });
    await expect(client.listModels()).rejects.toMatchObject({
      name: "ProviderError",
      message: "Unauthorized",
      status: 401,
    });
  });

  test("rejects invalid protocols", async () => {
    const client = createOpenAICompatibleClient({ baseUrl: "file:///tmp", model: "demo" });
    await expect(client.listModels()).rejects.toBeInstanceOf(ProviderError);
  });
});
