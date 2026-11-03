import { describe, expect, test } from "bun:test";
import { buildSpecialistInstructions, selectSpecialists } from "../src/specialists";

describe("specialist routing", () => {
  test("routes coding tasks through explorer, coder, and reviewer", () => {
    expect(selectSpecialists("Debug project and fix login bug").map((item) => item.role))
      .toEqual(["explorer", "coder", "reviewer"]);
  });
  test("routes research without workspace roles", () => {
    expect(selectSpecialists("Compare latest documentation").map((item) => item.role))
      .toEqual(["researcher"]);
  });
  test("does not assign workspace roles when workspace is disabled", () => {
    expect(selectSpecialists("Fix project bug", false).map((item) => item.role)).toEqual(["reviewer"]);
  });
  test("instructions disclose sequential same-model behavior and preserve approvals", () => {
    const prompt = buildSpecialistInstructions(selectSpecialists("Implement project feature"));
    expect(prompt).toContain("same model");
    expect(prompt).toContain("user approval gates");
    expect(prompt).toContain("EXPLORER");
    expect(prompt).toContain("CODER");
    expect(prompt).toContain("REVIEWER");
  });
  test("does not create a specialist pass for a simple chat", () => {
    expect(selectSpecialists("Hi, how are you?")).toEqual([]);
  });
});
