#!/usr/bin/env bun
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConversationStore, saveConversationStore, createConversation, getActiveConversation, switchConversation } from "./storage/conversations";
import {
  BoxRenderable,
  InputRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  createCliRenderer,
} from "@opentui/core";
import { resolveProviderEnvironment } from "./providers/registry";
import {
  createOpenAICompatibleClient,
  type ChatMessage,
  type ModelInfo,
  ProviderError,
} from "./providers/openai-compatible";

const initialProvider = resolveProviderEnvironment({
  AKANECHAT_PROVIDER: process.env.AKANECHAT_PROVIDER,
  AKANECHAT_BASE_URL: process.env.AKANECHAT_BASE_URL,
  AKANECHAT_API_KEY: process.env.AKANECHAT_API_KEY,
  AKANECHAT_MODEL: process.env.AKANECHAT_MODEL,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  OLLAMA_API_KEY: process.env.OLLAMA_API_KEY,
});
let baseUrl = initialProvider?.config.baseUrl ?? "";
let apiKey = initialProvider?.config.apiKey;
let model = initialProvider?.config.model ?? "";
let providerName = initialProvider?.definition.name ?? "Not configured";
let configured = Boolean(initialProvider);
let client = initialProvider
  ? createOpenAICompatibleClient(initialProvider.config)
  : undefined;
let activeRequest: AbortController | undefined;

const historyPath = join(homedir(), ".local", "share", "akanechat", "history.json");
const store = await loadConversationStore(historyPath);
let history = getActiveConversation(store);

async function saveHistory(): Promise<void> {
  try {
    history.updatedAt = new Date().toISOString();
    await saveConversationStore(historyPath, store);
  } catch {
    setStatus("Could not save local history");
  }
}

const renderer = await createCliRenderer({ exitOnCtrlC: true, targetFps: 30 });
const root = new BoxRenderable(renderer, {
  width: "100%", height: "100%", flexDirection: "column", backgroundColor: "#10131A", padding: 1, gap: 1,
});
const header = new BoxRenderable(renderer, {
  width: "100%", height: 3, border: true, borderColor: "#414B5D", paddingLeft: 1, justifyContent: "center",
});
header.add(new TextRenderable(renderer, { content: "AKANECHAT  ·  Terminal AI workspace", fg: "#F2A6C7" }));

const body = new BoxRenderable(renderer, { width: "100%", flexGrow: 1, flexDirection: "row", gap: 1 });
const sidebar = new BoxRenderable(renderer, {
  width: 27, border: true, borderColor: "#414B5D", padding: 1, flexDirection: "column", gap: 1,
});
sidebar.add(new TextRenderable(renderer, { content: "WORKSPACE", fg: "#F2A6C7" }));
const conversationInfo = new TextRenderable(renderer, { content: `●  ${history.title}\n${history.id.slice(0, 8)}`, fg: "#D8DEE9" });
sidebar.add(conversationInfo);
sidebar.add(new TextRenderable(renderer, { content: "\nPROVIDER", fg: "#F2A6C7" }));
const providerInfo = new TextRenderable(renderer, {
  content: configured ? `${providerName}\n${baseUrl}\n\nModel\n${model}` : "Not configured\n\nSet AKANECHAT_PROVIDER\nAKANECHAT_MODEL\nProvider API key",
  fg: "#AAB4C5",
});
sidebar.add(providerInfo);
sidebar.add(new TextRenderable(renderer, { content: "\nCOMMANDS", fg: "#F2A6C7" }));
sidebar.add(new TextRenderable(renderer, { content: "/models  list models\n/new     new chat\n/chats   chat history\n/switch  switch chat\n/clear   clear current\n/help    show help", fg: "#8792A5" }));

const panel = new BoxRenderable(renderer, {
  flexGrow: 1, border: true, borderColor: "#414B5D", padding: 1, flexDirection: "column", gap: 1,
});
const transcript = new ScrollBoxRenderable(renderer, {
  flexGrow: 1, width: "100%", border: false, padding: 1, stickyScroll: true, stickyStart: "bottom",
  contentOptions: { flexDirection: "column", gap: 1 },
});
panel.add(new TextRenderable(renderer, { content: "CONVERSATION", fg: "#F2A6C7" }));
panel.add(transcript);

const composer = new BoxRenderable(renderer, {
  width: "100%", height: 3, border: true, borderColor: "#F2A6C7", paddingLeft: 1, justifyContent: "center",
});
const input = new InputRenderable(renderer, {
  width: "100%", placeholder: configured ? "Message AkaneChat… (Enter to send)" : "Configure provider first…",
  backgroundColor: "#10131A", focusedBackgroundColor: "#10131A", textColor: "#F2F4F8", focusedTextColor: "#FFFFFF",
});
composer.add(input);
panel.add(composer);
body.add(sidebar);
body.add(panel);

const statusLine = new TextRenderable(renderer, {
  content: configured ? `${providerName} · ${model}` : "Provider not configured  ·  See README for setup",
  fg: "#8792A5",
});
const footer = new BoxRenderable(renderer, {
  width: "100%", height: 3, border: true, borderColor: "#414B5D", paddingLeft: 1, justifyContent: "center",
});
footer.add(statusLine);
root.add(header);
root.add(body);
root.add(footer);
renderer.root.add(root);

function setStatus(message: string): void {
  statusLine.content = message;
}

function addLine(label: string, content: string, color = "#D8DEE9"): TextRenderable {
  const line = new TextRenderable(renderer, { content: `${label}\n${content}`, fg: color });
  transcript.add(line);
  transcript.scrollTo({ x: 0, y: transcript.scrollHeight });
  return line;
}

function showWelcome(): void {
  addLine("AKANECHAT", "Your terminal AI workspace is ready.\n\nType a message below to start. Use /help for commands.", "#AAB4C5");
  if (!configured) {
    addLine("SETUP REQUIRED", "Set AKANECHAT_PROVIDER, AKANECHAT_MODEL, and the matching provider API key. Legacy AKANECHAT_BASE_URL configuration is still supported.", "#F2A6C7");
  }
  for (const message of history.messages) addLine(message.role.toUpperCase(), message.content, message.role === "user" ? "#F2A6C7" : "#D8DEE9");
}
showWelcome();

async function listModels(): Promise<void> {
  if (!client) {
    addLine("SYSTEM", "Provider is not configured. Set AKANECHAT_PROVIDER and AKANECHAT_MODEL, then restart.", "#F2A6C7");
    return;
  }
  setStatus("Fetching available models…");
  try {
    const models: ModelInfo[] = await client.listModels();
    addLine("AVAILABLE MODELS", models.length ? models.map((item) => `${item.id}${item.id === model ? "  ← current" : ""}`).join("\n") : "No models returned by provider.", "#AAB4C5");
    setStatus(`Loaded ${models.length} model(s) · ${model}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    addLine("PROVIDER ERROR", message, "#FF8A8A");
    setStatus("Model discovery failed");
  }
}

async function sendMessage(raw: string): Promise<void> {
  const content = raw.trim();
  if (!content) return;
  if (content === "/help") {
    addLine("HELP", "/connect <url> <model>  connect provider for this session\n/models                 list provider models\n/model <id>             switch model\n/new                    start a fresh conversation\n/chats                  list saved conversations\n/switch <id-prefix>     switch conversation\n/clear                  clear only the current conversation\n/help                   show this help\n/quit                   exit AkaneChat", "#AAB4C5");
    return;
  }
  if (content === "/models") return listModels();
  if (content.startsWith("/connect ")) {
    const args = content.slice(9).trim().split(/\s+/);
    if (args.length < 2) {
      addLine("USAGE", "/connect <base-url> <model-id>\nExample: /connect http://127.0.0.1:20128/v1 my-model", "#AAB4C5");
      return;
    }
    const nextBaseUrl = args[0]!;
    const nextModel = args.slice(1).join(" ");
    try {
      const nextClient = createOpenAICompatibleClient({ baseUrl: nextBaseUrl, apiKey, model: nextModel });
      baseUrl = nextBaseUrl;
      model = nextModel;
      providerName = "Custom endpoint";
      client = nextClient;
      configured = true;
      providerInfo.content = `${providerName}\n${baseUrl}\n\nModel\n${model}\n\nConnected for this session`;
      setStatus(`Provider configured · ${model}`);
      addLine("SYSTEM", `Provider target set to ${baseUrl} with model ${model}. API key remains sourced from AKANECHAT_API_KEY.`, "#AAB4C5");
    } catch (error) {
      addLine("CONFIG ERROR", error instanceof Error ? error.message : String(error), "#FF8A8A");
    }
    return;
  }
  if (content.startsWith("/model ")) {
    const nextModel = content.slice(7).trim();
    if (!nextModel) return;
    if (!client) {
      addLine("SYSTEM", "Connect a provider first with /connect <base-url> <model-id>.", "#F2A6C7");
      return;
    }
    model = nextModel;
    client = createOpenAICompatibleClient({ baseUrl, apiKey, model });
    providerInfo.content = `${providerName}\n${baseUrl}\n\nModel\n${model}`;
    setStatus(`Model selected · ${model}`);
    addLine("SYSTEM", `Model changed to ${model}.`, "#AAB4C5");
    return;
  }
  if (content === "/new") {
    history = createConversation(store);
    conversationInfo.content = `●  ${history.title}\n${history.id.slice(0, 8)}`;
    for (const child of transcript.getChildren()) transcript.remove(child);
    addLine("SYSTEM", `New conversation started · ${history.id.slice(0, 8)}`, "#AAB4C5");
    await saveHistory();
    return;
  }
  if (content === "/chats") {
    const lines = store.conversations.slice(0, 30).map((item) => `${item.id.slice(0, 8)}  ${item.id === store.activeId ? "← active  " : "          "}${item.title} (${item.messages.length} messages)`);
    addLine("SAVED CONVERSATIONS", lines.join("\n") || "No saved conversations.", "#AAB4C5");
    return;
  }
  if (content.startsWith("/switch ")) {
    const id = content.slice(8).trim();
    const selected = switchConversation(store, id);
    if (!selected) {
      addLine("SYSTEM", "Conversation not found or ID prefix is ambiguous. Use /chats to see IDs.", "#F2A6C7");
      return;
    }
    history = selected;
    conversationInfo.content = `●  ${history.title}\n${history.id.slice(0, 8)}`;
    for (const child of transcript.getChildren()) transcript.remove(child);
    for (const message of history.messages) addLine(message.role.toUpperCase(), message.content, message.role === "user" ? "#F2A6C7" : "#D8DEE9");
    setStatus(`Opened conversation · ${history.id.slice(0, 8)}`);
    await saveHistory();
    return;
  }
  if (content === "/clear") {
    history.messages = [];
    history.title = "New conversation";
    history.updatedAt = new Date().toISOString();
    conversationInfo.content = `●  ${history.title}\n${history.id.slice(0, 8)}`;
    for (const child of transcript.getChildren()) transcript.remove(child);
    addLine("SYSTEM", "Current conversation cleared. Other saved conversations were kept.", "#AAB4C5");
    await saveHistory();
    return;
  }
  if (content === "/quit") {
    renderer.destroy();
    return;
  }
  if (!client) {
    addLine("SYSTEM", "Cannot send yet: provider is not configured. Set AKANECHAT_PROVIDER and AKANECHAT_MODEL, then restart AkaneChat.", "#F2A6C7");
    return;
  }

  const userMessage: ChatMessage = { role: "user", content };
  history.messages.push(userMessage);
  if (history.messages.filter((message) => message.role === "user").length === 1) {
    history.title = content.replace(/\s+/g, " ").slice(0, 48) || "New conversation";
    conversationInfo.content = `●  ${history.title}\n${history.id.slice(0, 8)}`;
  }
  addLine("YOU", content, "#F2A6C7");
  const assistantLine = addLine("AKANE", "", "#D8DEE9");
  const assistantMessage: ChatMessage = { role: "assistant", content: "" };
  const pending = [...history.messages];
  setStatus(`Generating with ${model}… · Esc to stop`);
  input.blur();
  const requestController = new AbortController();
  activeRequest = requestController;

  try {
    for await (const chunk of client.streamChat(pending, requestController.signal)) {
      assistantMessage.content += chunk;
      assistantLine.content = `AKANE\n${assistantMessage.content}`;
      transcript.scrollTo({ x: 0, y: transcript.scrollHeight });
    }
    if (!assistantMessage.content) assistantMessage.content = "(Provider returned an empty response.)";
    history.messages.push(assistantMessage);
    await saveHistory();
    setStatus(`Ready · ${model}`);
  } catch (error) {
    if (requestController.signal.aborted) {
      if (assistantMessage.content) {
        history.messages.push(assistantMessage);
        await saveHistory();
      }
      assistantLine.content = `AKANE (stopped)\n${assistantMessage.content || "Generation cancelled."}`;
      setStatus("Generation stopped · partial answer kept");
    } else {
      const message = error instanceof ProviderError ? error.message : error instanceof Error ? error.message : String(error);
      assistantLine.content = `ERROR\n${message}`;
      setStatus("Request failed · check provider settings");
    }
  } finally {
    if (activeRequest === requestController) activeRequest = undefined;
    input.focus();
  }
}

input.onSubmit = () => {
  const value = input.value;
  input.value = "";
  void sendMessage(value);
};
input.focus();
renderer.keyInput.on("keypress", (key) => {
  if (key.name === "escape" && activeRequest) {
    activeRequest.abort();
    return;
  }
  if (key.ctrl && key.name === "c") renderer.destroy();
});
