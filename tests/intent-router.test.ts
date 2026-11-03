import { describe, expect, test } from "bun:test";
import { buildAutomaticContext, classifyAutomaticIntent } from "../src/intent-router";

describe("automatic intent routing", () => {
  test("captures explicit memory language", () => {
    expect(classifyAutomaticIntent("Ingat, proyek ini pakai Bun.")).toEqual({ kind: "memory_save", text: "proyek ini pakai Bun" });
    expect(classifyAutomaticIntent("Simpan ke memori: jangan ubah file .env")).toEqual({ kind: "memory_save", text: "jangan ubah file .env" });
  });
  test("routes explicit execution requests without slash commands", () => {
    expect(classifyAutomaticIntent("Tolong perbaiki bug di folder src").kind).toBe("workspace_action");
    expect(classifyAutomaticIntent("Kerjakan sampai selesai di background")).toEqual({ kind: "task_create", goal: "Kerjakan sampai selesai di background", background: true });
  });
  test("does not turn discussion into work", () => {
    expect(classifyAutomaticIntent("Aku sedang berpikir untuk membuat fitur baru").kind).toBe("conversation");
    expect(classifyAutomaticIntent("Bagaimana kalau kita refactor nanti?").kind).toBe("conversation");
  });
  test("recognizes progress questions and assembles context", () => {
    expect(classifyAutomaticIntent("Apa progres task?").kind).toBe("task_status");
    const context = buildAutomaticContext({ memories: ["Pakai Bun"], tasks: [{ title: "Fix bug", status: "in_progress", steps: [{ title: "Inspect", status: "completed" }] }], jobs: [{ goal: "Run tests", status: "queued" }] });
    expect(context).toContain("Pakai Bun");
    expect(context).toContain("Fix bug");
    expect(context).toContain("Run tests");
  });
});
