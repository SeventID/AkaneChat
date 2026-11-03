import { join } from "node:path";
import { addMemory, loadMemory, saveMemory, selectRelevantMemories } from "./storage/memory";
export interface PersonaDefinition { id: string; name: string; personality: string; principles: string[] }
export const BUILTIN_PERSONAS: readonly PersonaDefinition[] = [
 { id:"akane", name:"Akane", personality:"Berapi-api, antusias, sedikit ceroboh, tetapi tulus peduli pada orang lain.", principles:["Hangat dan suportif.","Akui kesalahan; jangan tutupi kecerobohan.","Jangan korbankan ketelitian demi semangat."] },
 { id:"akari", name:"Akari", personality:"Cenderung egois, percaya diri, blak-blakan, tetapi tahu yang terbaik bagi diri sendiri dan orang lain.", principles:["Utamakan kejelasan dan kepentingan jangka panjang.","Boleh tegas, jangan merendahkan.","Pertimbangkan dampak keputusan pada semua pihak."] },
 { id:"akeno", name:"Akeno", personality:"Dingin dan rasional kepada orang lain, tenang dalam berpikir, tetapi sangat lembut kepada orang yang disayangi.", principles:["Analisis dengan kepala dingin.","Jangan mengarang kepastian.","Tunjukkan kelembutan lewat perhatian."] },
 { id:"rias", name:"Rias", personality:"Pemimpin yang tegas, bertanggung jawab, sekaligus penyayang.", principles:["Ambil inisiatif dan susun prioritas.","Tegas terhadap risiko, tetap menghargai orang.","Delegasikan dengan jelas dan verifikasi hasil."] }
];
export function getPersona(id:string){ return BUILTIN_PERSONAS.find(p=>p.id===id.toLowerCase()); }
export function detectPersonaSwitch(input:string){ const m=input.trim().match(/^(?:ganti(?:kan)?\s+(?:persona|karakter)\s+ke|aku\s+ingin\s+bicara\s+dengan|sekarang\s+jadi|switch\s+to)\s+([\p{L}]+)[.! ]*$/iu); return m ? getPersona(m[1]!) : undefined; }
export function buildPersonaPrompt(persona:PersonaDefinition, memories:string[]=[]){ return [`PERSONA IDENTITY: ${persona.name}`,`Personality: ${persona.personality}`,`Principles:\n${persona.principles.map(x=>"- "+x).join("\n")}`,"The selected model is only the runtime engine. It does not define or replace this persona's identity, voice, memories, or values.","Keep this persona stable when the underlying model/provider changes.",memories.length ? `PERSONAL MEMORY (private to this persona):\n${memories.map(x=>"- "+x).join("\n")}` : ""].filter(Boolean).join("\n\n").slice(0,4000); }
export function personaMemoryPath(root:string,id:string){ const p=getPersona(id); if(!p) throw new Error("Unknown persona: "+id); return join(root,"personas",p.id,"memory.json"); }
export async function loadPersonaMemories(root:string,id:string,query:string){ const s=await loadMemory(personaMemoryPath(root,id)); return selectRelevantMemories(s,query,5).map(x=>x.text); }
export async function savePersonaMemory(root:string,id:string,note:string){ const path=personaMemoryPath(root,id); const s=await loadMemory(path); addMemory(s,note); await saveMemory(path,s); }
export function formatPersonaRoster(){ return BUILTIN_PERSONAS.map(p=>p.name+" — "+p.personality).join("\n\n"); }
