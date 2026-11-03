import { parseCapabilityList, routeCapability, type CapabilityModel, type ModelCapability } from "./capability-router";

const CAPABILITY_SET = new Set<ModelCapability>(["chat", "reasoning", "coding", "vision", "image_generation", "video_generation", "audio", "tools"]);
const MODEL_ID = /^[a-z0-9._-]+::[^\s]{1,250}$/i;

export function setModelCapabilities(registry: Record<string, string[]>, id: string, values: unknown): Record<string, string[]> {
  if (!MODEL_ID.test(id)) throw new Error("Model ID must use provider::model format.");
  if (!Array.isArray(values) || values.length === 0 || values.length > 8 || values.some((value) => typeof value !== "string" || !CAPABILITY_SET.has(value as ModelCapability))) {
    throw new Error("Provide one or more valid, explicitly verified capabilities.");
  }
  if (!registry[id] && Object.keys(registry).length >= 200) throw new Error("Capability registry limit reached (200 models).");
  return { ...registry, [id]: parseCapabilityList(values) };
}

export function removeModelCapabilities(registry: Record<string, string[]>, id: string): Record<string, string[]> {
  const next = { ...registry };
  delete next[id];
  return next;
}

export function routeRegisteredModel(
  registry: Record<string, string[]>,
  availableModels: Array<{ id: string; provider: string; available: boolean; priority?: number }>,
  capability: ModelCapability,
  preferred?: string,
) {
  const models: CapabilityModel[] = availableModels.map((model) => ({ ...model, capabilities: parseCapabilityList(registry[model.id]) }));
  return routeCapability(models, capability, preferred);
}
