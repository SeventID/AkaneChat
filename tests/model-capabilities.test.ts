import { describe, expect, test } from "bun:test";
import { removeModelCapabilities, routeRegisteredModel, setModelCapabilities } from "../src/model-capabilities";

describe("explicit model capability registry", () => {
  test("stores only valid declared capabilities", () => {
    const result = setModelCapabilities({}, "router::vision-v1", ["chat", "vision", "vision"]);
    expect(result["router::vision-v1"]).toEqual(["chat", "vision"]);
  });
  test("rejects unsafe IDs and unknown capabilities", () => {
    expect(() => setModelCapabilities({}, "router model", ["vision"])).toThrow();
    expect(() => setModelCapabilities({}, "router::model", ["shell"])).toThrow();
  });
  test("routes only to available models with explicitly registered capability", () => {
    const registry = { "router::vision": ["chat", "vision"], "router::chat": ["chat"] };
    const models = [
      { id: "router::vision", provider: "router", available: true },
      { id: "router::chat", provider: "router", available: true },
      { id: "router::offline", provider: "router", available: false },
    ];
    expect(routeRegisteredModel(registry, models, "vision").selected?.id).toBe("router::vision");
    expect(routeRegisteredModel(registry, models, "video_generation").selected).toBeUndefined();
  });
  test("removes capability metadata without mutating original registry", () => {
    const original = { "router::vision": ["vision"] };
    expect(removeModelCapabilities(original, "router::vision")).toEqual({});
    expect(original["router::vision"]).toEqual(["vision"]);
  });
});
