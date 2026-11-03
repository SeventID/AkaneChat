import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { saveGeneratedMedia } from "../src/media-output";

describe("generated media output", () => {
  test("saves base64 image with restrictive permissions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "akane-media-"));
    try {
      const path = await saveGeneratedMedia({ base64: Buffer.from("image-bytes").toString("base64"), mimeType: "image/png" }, dir);
      expect(path).toMatch(/\.png$/);
      expect(await readFile(path!)).toEqual(Buffer.from("image-bytes"));
      expect((await stat(path!)).mode & 0o777).toBe(0o600);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  test("rejects invalid data and unsupported MIME types", async () => {
    await expect(saveGeneratedMedia({ base64: "%%%" }, tmpdir())).rejects.toThrow("invalid");
    await expect(saveGeneratedMedia({ base64: "aGVsbG8=", mimeType: "text/plain" }, tmpdir())).rejects.toThrow("Unsupported");
  });
});
