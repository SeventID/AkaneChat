import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import type { ChatMessage } from "../providers/openai-compatible";

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface ConversationStore {
  version: 1;
  activeId: string;
  conversations: Conversation[];
}

function makeConversation(title = "New conversation", messages: ChatMessage[] = []): Conversation {
  const now = new Date().toISOString();
  return { id: randomUUID(), title, messages, createdAt: now, updatedAt: now };
}

export function createConversation(store: ConversationStore): Conversation {
  const conversation = makeConversation();
  store.conversations.unshift(conversation);
  store.activeId = conversation.id;
  return conversation;
}

export function getActiveConversation(store: ConversationStore): Conversation {
  return store.conversations.find((item) => item.id === store.activeId) ?? store.conversations[0]!;
}

export function switchConversation(store: ConversationStore, idPrefix: string): Conversation | undefined {
  const matches = store.conversations.filter((item) => item.id.startsWith(idPrefix));
  if (matches.length !== 1) return undefined;
  store.activeId = matches[0]!.id;
  return matches[0];
}

export function createEmptyStore(): ConversationStore {
  const first = makeConversation();
  return { version: 1, activeId: first.id, conversations: [first] };
}

export async function loadConversationStore(path: string): Promise<ConversationStore> {
  try {
    const raw = JSON.parse(await Bun.file(path).text()) as Partial<ConversationStore> & { messages?: ChatMessage[]; updatedAt?: string };
    if (Array.isArray(raw.conversations) && raw.conversations.length > 0) {
      const conversations = raw.conversations.filter((item): item is Conversation =>
        Boolean(item && typeof item.id === "string" && Array.isArray(item.messages)),
      );
      if (conversations.length) {
        const activeId = conversations.some((item) => item.id === raw.activeId) ? raw.activeId! : conversations[0]!.id;
        return { version: 1, activeId, conversations };
      }
    }
    // Migrate the previous single-history format without discarding messages.
    if (Array.isArray(raw.messages)) {
      const migrated = makeConversation("Imported conversation", raw.messages);
      if (raw.updatedAt) migrated.updatedAt = raw.updatedAt;
      return { version: 1, activeId: migrated.id, conversations: [migrated] };
    }
  } catch {
    // Missing or malformed history starts with an empty store.
  }
  return createEmptyStore();
}

export async function saveConversationStore(path: string, store: ConversationStore): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await chmod(tempPath, 0o600);
  await rename(tempPath, path);
}
