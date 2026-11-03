import { describe, expect, test } from "bun:test";
import { inferRequiredCapability, routeCapability, type CapabilityModel } from "../src/capability-router";
describe("capability routing",()=>{
 test("distinguishes image and video generation from vision",()=>{ expect(inferRequiredCapability("Buatkan gambar anime")).toBe("image_generation"); expect(inferRequiredCapability("Tolong buat video pendek")).toBe("video_generation"); expect(inferRequiredCapability("Analisis gambar ini")).toBe("vision"); });
 test("selects only explicitly capable and available models",()=>{ const models:CapabilityModel[]=[{id:"chat-only",provider:"x",capabilities:["chat"],available:true},{id:"img-gen",provider:"y",capabilities:["image_generation"],available:true},{id:"video-offline",provider:"z",capabilities:["video_generation"],available:false}]; expect(routeCapability(models,"image_generation").selected?.id).toBe("img-gen"); expect(routeCapability(models,"video_generation").selected).toBeUndefined(); });
});

test("does not classify discussion about media as a generation request",()=>{ expect(inferRequiredCapability("Apa perbedaan model video dan gambar?")).toBe("chat"); expect(inferRequiredCapability("Bagaimana cara edit foto di HP?")).toBe("chat"); });
