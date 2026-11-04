import { describe, expect, test } from "bun:test";
import pkg from "../package.json";

describe("AkaneChat package metadata", () => {
  test("uses the public package name and Apache-2.0 license", () => {
    expect(pkg.name).toBe("akanechat");
    expect(pkg.license).toBe("Apache-2.0");
    expect(pkg.bin).toEqual({ akanechat: "akanechat" });
  });
});
