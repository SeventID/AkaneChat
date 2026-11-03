export const PERSONA_IDS = ["akane", "akari", "akeno", "rias"] as const;
export type PersonaId = typeof PERSONA_IDS[number];
export type PersonaModelMap = Partial<Record<PersonaId, string>>;

export function parsePersonaModelAssignment(input: string): { persona: PersonaId; specification: string } | undefined {
  const match = input.trim().match(/^(?:untuk\s+|setel\s+model\s+)(akane|akari|akeno|rias)\s+(?:gunakan|pakai|modelnya)\s+(.+)$/i);
  if (!match) return undefined;
  const specification = match[2]!.trim();
  if (!specification || specification.length > 300 || /\s/.test(specification) || !specification.includes("::")) return undefined;
  return { persona: match[1]!.toLowerCase() as PersonaId, specification };
}

export function assignPersonaModel(map: PersonaModelMap, persona: string, specification: string): PersonaModelMap {
  if (!PERSONA_IDS.includes(persona as PersonaId)) throw new Error("Unknown persona.");
  if (!specification.trim() || specification.length > 300) throw new Error("Invalid provider/model specification.");
  return { ...map, [persona]: specification.trim() };
}

export function getPersonaModel(map: PersonaModelMap, persona: string): string | undefined {
  return PERSONA_IDS.includes(persona as PersonaId) ? map[persona as PersonaId] : undefined;
}
