import { describe, expect, test } from "bun:test";
import { diffWorkspaceSnapshots } from "../src/file-change-tracker";

describe("workspace file change tracker", () => {
  test("detects created, modified, and deleted files from hashes", () => {
    const before = [{ path: "same.ts", sha256: "a" }, { path: "old.ts", sha256: "b" }];
    const after = [{ path: "same.ts", sha256: "c" }, { path: "new.ts", sha256: "d" }];
    expect(diffWorkspaceSnapshots(before, after)).toEqual([
      { path: "new.ts", change: "created", after: "d" },
      { path: "old.ts", change: "deleted", before: "b" },
      { path: "same.ts", change: "modified", before: "a", after: "c" },
    ]);
  });
  test("does not report unchanged files", () => {
    expect(diffWorkspaceSnapshots([{ path: "a", sha256: "x" }], [{ path: "a", sha256: "x" }])).toEqual([]);
  });
});
