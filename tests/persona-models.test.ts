import { describe, expect, test } from "bun:test";
import { assignPersonaModel, getPersonaModel, parsePersonaModelAssignment } from "../src/persona-models";

describe("per-persona model bindings", () => {
  test("parses natural language provider/model assignment", () => {
    expect(parsePersonaModelAssignment("Untuk Akari gunakan anthropic::claude-opus-5")).toEqual({ persona: "akari", specification: "anthropic::claude-opus-5" });
  });
  test("keeps model bindings independent", () => {
    const map = assignPersonaModel(assignPersonaModel({}, "akane", "openai::gpt-test"), "akari", "anthropic::claude-test");
    expect(getPersonaModel(map, "akane")).toBe("openai::gpt-test");
    expect(getPersonaModel(map, "akari")).toBe("anthropic::claude-test");
    expect(getPersonaModel(map, "rias")).toBeUndefined();
  });
});
