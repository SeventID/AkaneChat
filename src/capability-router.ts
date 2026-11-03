export type ModelCapability = "chat"|"reasoning"|"coding"|"vision"|"image_generation"|"video_generation"|"audio"|"tools";
export interface CapabilityModel { id:string; provider:string; capabilities:ModelCapability[]; available:boolean; priority?:number }
export function inferRequiredCapability(text:string):ModelCapability {
 const value=text.toLocaleLowerCase("id-ID");
 const has=(pattern:RegExp)=>pattern.test(value);
 const asksGenerate=has(/\b(buat|buatkan|generate|hasilkan|create|render|edit|ubah|jadikan)\b/) && !has(/\b(bagaimana|gimana|cara|tutorial|kenapa|apa itu)\b/);
 const video=has(/\b(video|film|animasi|clip)\b/);
 const image=has(/\b(gambar|image|ilustrasi|foto|wallpaper|avatar)\b/);
 const vision=has(/\b(analisis|analisa|jelaskan|describe|lihat|baca|identifikasi|periksa)\b/);
 if (asksGenerate && video) return "video_generation";
 if (asksGenerate && image) return "image_generation";
 if (vision && image) return "vision";
 if (has(/\b(audio|suara|transkrip|speech|musik)\b/)) return "audio";
 if (has(/\b(debug|coding|kode|program|implementasi|refactor)\b/)) return "coding";
 return "chat";
}
export function routeCapability(models:CapabilityModel[], capability:ModelCapability, preferred?:string){ const matches=models.filter(m=>m.available&&m.capabilities.includes(capability)).sort((a,b)=>(b.priority??0)-(a.priority??0)); const selected=matches.find(m=>m.id===preferred)??matches[0]; return {selected, alternatives:matches.filter(m=>m.id!==selected?.id), reason:selected ? selected.id+" explicitly supports "+capability : "No available model is registered with "+capability+"; do not pretend the current model can do it."}; }
export function parseCapabilityList(value:unknown):ModelCapability[]{ const allowed:ModelCapability[]=["chat","reasoning","coding","vision","image_generation","video_generation","audio","tools"]; return Array.isArray(value)?[...new Set(value.filter((x):x is ModelCapability=>typeof x==="string"&&allowed.includes(x as ModelCapability)))]:[]; }
