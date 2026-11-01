#!/usr/bin/env bun
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import {
  BoxRenderable,
  InputRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  createCliRenderer,
} from "@opentui/core";
import {
  createOpenAICompatibleClient,
  type ChatMessage,
  type ModelInfo,
  ProviderError,
} from "./providers/openai-compatible";

let baseUrl = process.env.AKANECHAT_BASE_URL?.trim() || "";
const apiKey = process.env.AKANECHAT_API_KEY?.trim() || undefined;
let model = process.env.AKANECHAT_MODEL?.trim() || "";
let configured = Boolean(baseUrl && model);
let client = baseUrl && model
  ? createOpenAICompatibleClient({ baseUrl, apiKey, model })
  : undefined;

interface SavedConversation {
  messages: ChatMessage[];
  updatedAt: string;
}
const historyPath = join(homedir(), ".local", "share", "akanechat", "history.json");
let history: SavedConversation = { messages: [], updatedAt: new Date().toISOString() };
try {
  const file = Bun.file(historyPath);
  if (await file.exists()) {
    const saved = (await file.json()) as SavedConversation;
    if (Array.isArray(saved.messages)) history = saved;
  }
} catch {
  // Start with an empty conversation if local history is unreadable.
}

async function saveHistory(): Promise<void> {
  try {
    await mkdir(dirname(historyPath), { recursive: true, mode: 0o700 });
    await Bun.write(historyPath, JSON.stringify({ ...history, updatedAt: new Date().toISOString() }, null, 2));
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
sidebar.add(new TextRenderable(renderer, { content: "●  Current conversation", fg: "#D8DEE9" }));
sidebar.add(new TextRenderable(renderer, { content: "\nPROVIDER", fg: "#F2A6C7" }));
const providerInfo = new TextRenderable(renderer, {
  content: configured ? `${baseUrl}\n\nModel\n${model}` : "Not configured\n\nSet these env vars:\nAKANECHAT_BASE_URL\nAKANECHAT_MODEL\nAKANECHAT_API_KEY (optional)",
  fg: "#AAB4C5",
});
sidebar.add(providerInfo);
sidebar.add(new TextRenderable(renderer, { content: "\nCOMMANDS", fg: "#F2A6C7" }));
sidebar.add(new TextRenderable(renderer, { content: "/models  list models\n/new     new chat\n/clear   clear chat\n/help    show help", fg: "#8792A5" }));

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
  content: configured ? `Connected target: ${baseUrl}  ·  Model: ${model}` : "Provider not configured  ·  See README for setup",
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
    addLine("SETUP REQUIRED", "Set AKANECHAT_BASE_URL and AKANECHAT_MODEL. API key is optional for local endpoints.", "#F2A6C7");
  }
  for (const message of history.messages) addLine(message.role.toUpperCase(), message.content, message.role === "user" ? "#F2A6C7" : "#D8DEE9");
}
showWelcome();

async function listModels(): Promise<void> {
  if (!client) {
    addLine("SYSTEM", "Provider is not configured. Set AKANECHAT_BASE_URL and AKANECHAT_MODEL, then restart.", "#F2A6C7");
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
    addLine("HELP", "/connect <url> <model>  connect provider for this session\n/models                 list provider models\n/model <id>             switch model\n/new                    start a fresh conversation\n/clear                  clear visible conversation and saved history\n/help                   show this help\n/quit                   exit AkaneChat", "#AAB4C5");
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
      client = nextClient;
      configured = true;
      providerInfo.content = `${baseUrl}\n\nModel\n${model}\n\nConnected for this session`;
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
    providerInfo.content = `${baseUrl}\n\nModel\n${model}`;
    setStatus(`Model selected · ${model}`);
    addLine("SYSTEM", `Model changed to ${model}.`, "#AAB4C5");
    return;
  }
  if (content === "/new" || content === "/clear") {
    history = { messages: [], updatedAt: new Date().toISOString() };
    for (const child of transcript.getChildren()) transcript.remove(child);
    addLine("SYSTEM", "New conversation started.", "#AAB4C5");
    await saveHistory();
    return;
  }
  if (content === "/quit") {
    renderer.destroy();
    return;
  }
  if (!client) {
    addLine("SYSTEM", "Cannot send yet: provider is not configured. Set AKANECHAT_BASE_URL and AKANECHAT_MODEL, then restart AkaneChat.", "#F2A6C7");
    return;
  }

  const userMessage: ChatMessage = { role: "user", content };
  history.messages.push(userMessage);
  addLine("YOU", content, "#F2A6C7");
  const assistantLine = addLine("AKANE", "", "#D8DEE9");
  const assistantMessage: ChatMessage = { role: "assistant", content: "" };
  const pending = [...history.messages];
  setStatus(`Generating with ${model}…`);
  input.blur();

  try {
    for await (const chunk of client.streamChat(pending)) {
      assistantMessage.content += chunk;
      assistantLine.content = `AKANE\n${assistantMessage.content}`;
      transcript.scrollTo({ x: 0, y: transcript.scrollHeight });
    }
    if (!assistantMessage.content) assistantMessage.content = "(Provider returned an empty response.)";
    history.messages.push(assistantMessage);
    await saveHistory();
    setStatus(`Ready · ${model}`);
  } catch (error) {
    const message = error instanceof ProviderError ? error.message : error instanceof Error ? error.message : String(error);
    assistantLine.content = `ERROR\n${message}`;
    setStatus("Request failed · check provider settings");
  } finally {
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
  if (key.ctrl && key.name === "c") renderer.destroy();
});
