import { describe, expect, test } from "bun:test";
import { loadMediaAdapters } from "../src/media-config";

describe("media adapter configuration", () => {
  test("does not register incomplete credentials", () => {
    expect(loadMediaAdapters({ AKANECHAT_IMAGE_ENDPOINT: "https://api.example.test/images" })).toHaveLength(0);
  });
  test("registers independent primary and fallback adapters", () => {
    const adapters = loadMediaAdapters({
      AKANECHAT_IMAGE_ENDPOINT: "https://api.example.test/v1/images/generations", AKANECHAT_IMAGE_API_KEY: "primary-secret",
      AKANECHAT_IMAGE_FALLBACK_ENDPOINT: "https://backup.example.test/v1/images/generations", AKANECHAT_IMAGE_FALLBACK_API_KEY: "backup-secret",
      AKANECHAT_VIDEO_ENDPOINT: "https://api.example.test/v1/videos", AKANECHAT_VIDEO_API_KEY: "video-secret",
    });
    expect(adapters.map((item) => item.id)).toEqual(["image-primary", "image-fallback", "video-primary"]);
    expect(adapters.map((item) => item.capability)).toEqual(["image_generation", "image_generation", "video_generation"]);
  });
});
