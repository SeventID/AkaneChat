import type { ProviderConfig } from "./openai-compatible";

export type ProviderKind = "openai-compatible";

export interface ProviderDefinition {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl?: string;
  apiKeyEnv?: string;
  requiresApiKey: boolean;
  description: string;
}

/** Built-in endpoints that expose the OpenAI Chat Completions API. */
export const PROVIDER_REGISTRY: readonly ProviderDefinition[] = [
  {
    id: "openai",
    name: "OpenAI",
    kind: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    requiresApiKey: true,
    description: "OpenAI Chat Completions API",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    kind: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    requiresApiKey: true,
    description: "Multi-provider model gateway",
  },
  {
    id: "groq",
    name: "Groq",
    kind: "openai-compatible",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeyEnv: "GROQ_API_KEY",
    requiresApiKey: true,
    description: "Groq-hosted inference API",
  },
  {
    id: "ollama",
    name: "Ollama",
    kind: "openai-compatible",
    baseUrl: "http://127.0.0.1:11434/v1",
    requiresApiKey: false,
    description: "Local Ollama OpenAI-compatible endpoint",
  },
  {
    id: "custom",
    name: "Custom endpoint",
    kind: "openai-compatible",
    requiresApiKey: false,
    description: "Any OpenAI-compatible endpoint, including OmniRoute",
  },
] as const;

export interface ProviderEnvironment {
  AKANECHAT_PROVIDER?: string;
  AKANECHAT_BASE_URL?: string;
  AKANECHAT_API_KEY?: string;
  AKANECHAT_MODEL?: string;
  OPENAI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  GROQ_API_KEY?: string;
  OLLAMA_API_KEY?: string;
}

export interface ResolvedProvider {
  definition: ProviderDefinition;
  config: ProviderConfig;
  source: "legacy" | "registry";
}

export function getProviderDefinition(id: string): ProviderDefinition | undefined {
  return PROVIDER_REGISTRY.find((provider) => provider.id === id);
}

/**
 * Resolve provider settings without persisting credentials. Legacy AKANECHAT_*
 * variables retain precedence when no explicit provider is selected.
 */
export function resolveProviderEnvironment(
  env: ProviderEnvironment,
): ResolvedProvider | undefined {
  const model = env.AKANECHAT_MODEL?.trim();
  if (!model) return undefined;

  const selectedId = env.AKANECHAT_PROVIDER?.trim().toLowerCase();
  if (!selectedId && env.AKANECHAT_BASE_URL?.trim()) {
    return {
      definition: PROVIDER_REGISTRY.find((item) => item.id === "custom")!,
      config: {
        baseUrl: env.AKANECHAT_BASE_URL.trim(),
        apiKey: env.AKANECHAT_API_KEY?.trim() || undefined,
        model,
      },
      source: "legacy",
    };
  }

  const definition = getProviderDefinition(selectedId || "custom");
  if (!definition) throw new Error(`Unknown provider '${selectedId}'.`);

  const baseUrl = env.AKANECHAT_BASE_URL?.trim() || definition.baseUrl;
  if (!baseUrl) {
    throw new Error(`Provider '${definition.id}' requires AKANECHAT_BASE_URL.`);
  }

  const envKey = definition.apiKeyEnv
    ? env[definition.apiKeyEnv as keyof ProviderEnvironment]
    : undefined;
  const apiKey = env.AKANECHAT_API_KEY?.trim() || envKey?.trim() || undefined;
  if (definition.requiresApiKey && !apiKey) {
    throw new Error(`Provider '${definition.id}' requires ${definition.apiKeyEnv ?? "AKANECHAT_API_KEY"}.`);
  }

  return {
    definition,
    config: { baseUrl, apiKey, model },
    source: "registry",
  };
}
