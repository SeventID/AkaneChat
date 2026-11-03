import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_PERSONAS, buildPersonaPrompt, detectPersonaSwitch, loadPersonaMemories, savePersonaMemory } from "../src/personas";
describe("stable personas",()=>{
 test("defines four distinct identities and detects switching",()=>{ expect(BUILTIN_PERSONAS.map(x=>x.id)).toEqual(["akane","akari","akeno","rias"]); expect(detectPersonaSwitch("Aku ingin bicara dengan Akari")?.id).toBe("akari"); expect(detectPersonaSwitch("sekarang jadi Rias")?.id).toBe("rias"); });
 test("keeps persona identity in its prompt independent of model",()=>{ const prompt=buildPersonaPrompt(BUILTIN_PERSONAS[0]!); expect(prompt).toContain("PERSONA IDENTITY: Akane"); expect(prompt).toContain("runtime engine"); });
 test("isolates persistent memories per persona",async()=>{ const root=await mkdtemp(join(tmpdir(),"akane-persona-")); try { await savePersonaMemory(root,"akane","Suka teh melati"); await savePersonaMemory(root,"akari","Suka kopi"); expect(await loadPersonaMemories(root,"akane","teh melati")).toEqual(["Suka teh melati"]); expect(await loadPersonaMemories(root,"akari","kopi")).toEqual(["Suka kopi"]); expect(await loadPersonaMemories(root,"akeno","teh melati")).toEqual([]); } finally { await rm(root,{recursive:true,force:true}); } });
});
