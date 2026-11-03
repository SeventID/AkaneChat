import { describe, expect, test } from "bun:test";
import { createToolController } from "../src/tool-controller";

describe("Tool controller", () => {
  test("allows only known workspace tools", () => {
    const controller = createToolController();
    expect(controller.check("read_file", { path: "README.md" }).allowed).toBe(true);
    const blocked = controller.check("run_terminal_command", { command: "id" });
    expect(blocked.allowed).toBe(false);
    expect(controller.evidence.summary()).toContain("run_terminal_command: blocked");
  });

  test("records guard blocks and tool outcomes", () => {
    const controller = createToolController({ maxCalls: 1 });
    expect(controller.check("list_files", {}).allowed).toBe(true);
    controller.record("list_files", "succeeded", "Found files");
    expect(controller.check("read_file", { path: "a" }).allowed).toBe(false);
    expect(controller.stats().evidence.blocked).toBe(1);
    expect(controller.stats().evidence.succeeded).toBe(1);
  });
});
