import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export interface InlineMediaData { base64?: string; mimeType?: string }

export async function saveGeneratedMedia(data: InlineMediaData, directory: string): Promise<string | undefined> {
  if (!data.base64) return undefined;
  const mime = (data.mimeType ?? "image/png").toLowerCase();
  const extensions: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
  const extension = extensions[mime];
  if (!extension) throw new Error(`Unsupported generated image MIME type: ${mime}.`);
  if (data.base64.length > 40_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data.base64) || data.base64.length % 4 !== 0) {
    throw new Error("Generated image data is invalid or exceeds the 30 MB limit.");
  }
  const bytes = Buffer.from(data.base64, "base64");
  if (!bytes.length || bytes.length > 30_000_000 || bytes.toString("base64") !== data.base64) throw new Error("Generated image data is invalid or exceeds the 30 MB limit.");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${Date.now()}-${randomUUID()}.${extension}`);
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  return path;
}
