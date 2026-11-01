import { describe, expect, test } from "bun:test";
import {
  getProviderDefinition,
  PROVIDER_REGISTRY,
  resolveProviderEnvironment,
} from "../src/providers/registry";

describe("provider registry", () => {
  test("contains only providers currently supported by the OpenAI-compatible adapter", () => {
    expect(PROVIDER_REGISTRY.map((item) => item.id)).toEqual([
      "openai", "openrouter", "groq", "ollama", "custom",
    ]);
    expect(getProviderDefinition("openrouter")?.baseUrl).toBe("https://openrouter.ai/api/v1");
  });

  test("preserves legacy AKANECHAT environment configuration", () => {
    const resolved = resolveProviderEnvironment({
      AKANECHAT_BASE_URL: " http://127.0.0.1:20128/v1/ ",
      AKANECHAT_API_KEY: " legacy-secret ",
      AKANECHAT_MODEL: " local-model ",
    });
    expect(resolved?.source).toBe("legacy");
    expect(resolved?.config).toEqual({
      baseUrl: "http://127.0.0.1:20128/v1/",
      apiKey: "legacy-secret",
      model: "local-model",
    });
  });

  test("resolves OpenAI using its dedicated API key", () => {
    const resolved = resolveProviderEnvironment({
      AKANECHAT_PROVIDER: "openai",
      AKANECHAT_MODEL: "gpt-example",
      OPENAI_API_KEY: "openai-secret",
    });
    expect(resolved?.definition.id).toBe("openai");
    expect(resolved?.config).toEqual({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "openai-secret",
      model: "gpt-example",
    });
  });

  test("allows a local Ollama endpoint without an API key", () => {
    const resolved = resolveProviderEnvironment({
      AKANECHAT_PROVIDER: "ollama",
      AKANECHAT_MODEL: "qwen2.5:3b",
    });
    expect(resolved?.config.baseUrl).toBe("http://127.0.0.1:11434/v1");
    expect(resolved?.config.apiKey).toBeUndefined();
  });

  test("requires credentials for hosted providers", () => {
    expect(() => resolveProviderEnvironment({
      AKANECHAT_PROVIDER: "groq",
      AKANECHAT_MODEL: "llama-example",
    })).toThrow("GROQ_API_KEY");
  });

  test("allows a custom OmniRoute-compatible endpoint", () => {
    const resolved = resolveProviderEnvironment({
      AKANECHAT_PROVIDER: "custom",
      AKANECHAT_BASE_URL: "http://127.0.0.1:20128/v1",
      AKANECHAT_MODEL: "route/model",
      AKANECHAT_API_KEY: "gateway-secret",
    });
    expect(resolved?.definition.id).toBe("custom");
    expect(resolved?.config.baseUrl).toBe("http://127.0.0.1:20128/v1");
  });

  test("rejects unknown provider identifiers and missing model", () => {
    expect(() => resolveProviderEnvironment({
      AKANECHAT_PROVIDER: "not-real",
      AKANECHAT_MODEL: "model",
    })).toThrow("Unknown provider");
    expect(resolveProviderEnvironment({ AKANECHAT_PROVIDER: "openai" })).toBeUndefined();
  });
});
