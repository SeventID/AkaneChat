#!/usr/bin/env bun
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConversationStore, saveConversationStore, createConversation, getActiveConversation, switchConversation } from "./storage/conversations";
import { loadSettings, saveSettings } from "./storage/settings";
import {
  BoxRenderable,
  InputRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  createCliRenderer,
} from "@opentui/core";
import { getProviderDefinition, PROVIDER_REGISTRY, resolveProviderEnvironment } from "./providers/registry";
import { createAnthropicClient, createGeminiClient } from "./providers/native";
import {
  createOpenAICompatibleClient,
  type ChatMessage,
  type ModelInfo,
  ProviderError,
} from "./providers/openai-compatible";

const dataDirectory = join(homedir(), ".local", "share", "akanechat");
const settingsPath = join(dataDirectory, "settings.json");
const savedSettings = await loadSettings(settingsPath);
let startupConfigError: string | undefined;
const initialProvider = (() => {
  try {
    return resolveProviderEnvironment({
      AKANECHAT_PROVIDER: process.env.AKANECHAT_PROVIDER ?? savedSettings?.provider,
      AKANECHAT_BASE_URL: process.env.AKANECHAT_BASE_URL ?? savedSettings?.baseUrl,
      AKANECHAT_API_KEY: process.env.AKANECHAT_API_KEY,
      AKANECHAT_MODEL: process.env.AKANECHAT_MODEL ?? savedSettings?.model,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      GROQ_API_KEY: process.env.GROQ_API_KEY,
      OLLAMA_API_KEY: process.env.OLLAMA_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    });
  } catch (error) {
    startupConfigError = error instanceof Error ? error.message : String(error);
    return undefined;
  }
})();
let baseUrl = initialProvider?.config.baseUrl ?? "";
let apiKey = initialProvider?.config.apiKey;
let model = initialProvider?.config.model ?? "";
let providerName = initialProvider?.definition.name ?? "Not configured";
let providerId = initialProvider?.definition.id ?? "";
let configured = Boolean(initialProvider);
interface ChatProviderClient {
  listModels(): Promise<ModelInfo[]>;
  streamChat(messages: ChatMessage[], signal?: AbortSignal): AsyncGenerator<string>;
}
function createProviderClient(resolved: NonNullable<typeof initialProvider>): ChatProviderClient {
  if (resolved.definition.kind === "anthropic") {
    if (!resolved.config.apiKey) throw new Error("ANTHROPIC_API_KEY is required.");
    return createAnthropicClient({ apiKey: resolved.config.apiKey, model: resolved.config.model });
  }
  if (resolved.definition.kind === "gemini") {
    if (!resolved.config.apiKey) throw new Error("GEMINI_API_KEY is required.");
    return createGeminiClient({ apiKey: resolved.config.apiKey, model: resolved.config.model });
  }
  return createOpenAICompatibleClient(resolved.config);
}
let client = initialProvider ? createProviderClient(initialProvider) : undefined;
let activeRequest: AbortController | undefined;
let councilModels: string[] = savedSettings?.councilModels ?? [];

function createClientForModel(modelId: string): ChatProviderClient {
  const definition = getProviderDefinition(providerId);
  if (!definition) throw new Error("Select a provider first.");
  return createProviderClient({
    definition,
    config: { baseUrl, apiKey, model: modelId },
    source: "registry",
  });
}

function createCouncilClient(specification: string): ChatProviderClient {
  const separator = specification.indexOf("::");
  if (separator < 0) return createClientForModel(specification);
  const selectedId = specification.slice(0, separator).trim().toLowerCase();
  const selectedModel = specification.slice(separator + 2).trim();
  const definition = getProviderDefinition(selectedId);
  if (!definition || !selectedModel) throw new Error(`Invalid council agent '${specification}'. Use provider::model.`);
  const resolved = resolveProviderEnvironment({
    AKANECHAT_PROVIDER: selectedId,
    AKANECHAT_BASE_URL: selectedId === "custom" ? baseUrl : undefined,
    AKANECHAT_API_KEY: process.env.AKANECHAT_API_KEY,
    AKANECHAT_MODEL: selectedModel,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    OLLAMA_API_KEY: process.env.OLLAMA_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  });
  if (!resolved) throw new Error(`Could not configure council agent '${specification}'.`);
  return createProviderClient(resolved);
}

const historyPath = join(dataDirectory, "history.json");
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

async function persistProviderSettings(): Promise<void> {
  try {
    const definition = PROVIDER_REGISTRY.find((item) => item.name === providerName);
    await saveSettings(settingsPath, {
      version: 1,
      provider: definition?.id ?? providerId ?? "custom",
      model,
      ...(baseUrl ? { baseUrl } : {}),
      ...(councilModels.length ? { councilModels } : {}),
    });
  } catch {
    setStatus("Provider works, but settings could not be saved");
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
sidebar.add(new TextRenderable(renderer, { content: "\nCOUNCIL", fg: "#F2A6C7" }));
const councilInfo = new TextRenderable(renderer, {
  content: councilModels.length ? `${councilModels.length} agents\n${councilModels.join("\n")}` : "Off",
  fg: "#AAB4C5",
});
sidebar.add(councilInfo);
sidebar.add(new TextRenderable(renderer, { content: "\nCOMMANDS", fg: "#F2A6C7" }));
sidebar.add(new TextRenderable(renderer, { content: "/providers list providers\n/provider  choose provider\n/models    list models\n/model     choose model\n/new       new chat\n/chats     chat history\n/help      show help", fg: "#8792A5" }));

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
    addLine("SETUP REQUIRED", "Use /providers to inspect choices, then /provider <id> <model-id>. Provider API keys must be present in the matching environment variable.", "#F2A6C7");
  }
  if (startupConfigError) addLine("CONFIGURATION ERROR", startupConfigError, "#FF8A8A");
  for (const message of history.messages) addLine(message.role.toUpperCase(), message.content, message.role === "user" ? "#F2A6C7" : "#D8DEE9");
}
showWelcome();

async function listModels(filter = ""): Promise<void> {
  if (!client) {
    addLine("SYSTEM", "Provider is not configured. Set AKANECHAT_PROVIDER and AKANECHAT_MODEL, then restart.", "#F2A6C7");
    return;
  }
  setStatus("Fetching available models…");
  try {
    const models: ModelInfo[] = await client.listModels();
    const matching = filter ? models.filter((item) => item.id.toLowerCase().includes(filter.toLowerCase())) : models;
    const visible = matching.slice(0, 60);
    const heading = filter ? `AVAILABLE MODELS · filter: ${filter}` : "AVAILABLE MODELS · first 60";
    const listing = visible.map((item) => `${item.id}${item.id === model ? "  ← current" : ""}`).join("\n");
    const more = matching.length > visible.length ? `\n\nShowing ${visible.length} of ${matching.length} matches. Narrow with /models <filter>.` : `\n\n${matching.length} matching model(s).`;
    addLine(heading, listing || "No matching models.", "#AAB4C5");
    if (matching.length > 0) addLine("MODEL COUNT", more.trim(), "#8792A5");
    setStatus(`Loaded ${matching.length} matching model(s) · ${model}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    addLine("PROVIDER ERROR", message, "#FF8A8A");
    setStatus("Model discovery failed");
  }
}

async function collectResponse(target: ChatProviderClient, messages: ChatMessage[], signal: AbortSignal): Promise<string> {
  let output = "";
  for await (const chunk of target.streamChat(messages, signal)) output += chunk;
  return output;
}

async function sendCouncil(content: string): Promise<void> {
  if (!client || councilModels.length < 2) return;

  const userMessage: ChatMessage = { role: "user", content };
  history.messages.push(userMessage);
  if (history.messages.filter((message) => message.role === "user").length === 1) {
    history.title = content.replace(/\s+/g, " ").slice(0, 48) || "New conversation";
    conversationInfo.content = `●  ${history.title}\n${history.id.slice(0, 8)}`;
  }
  addLine("YOU", content, "#F2A6C7");
  const controller = new AbortController();
  activeRequest = controller;
  input.blur();
  const selected = [...councilModels];
  const agents = selected.map((id) => ({ id, line: addLine(`AGENT · ${id}`, "Thinking…", "#AAB4C5") }));
  const baseMessages = [...history.messages];
  try {
    setStatus(`Council · ${selected.length} agents thinking in parallel · Esc to stop`);
    const firstPass = await Promise.all(selected.map(async (id, index) => {
      try {
        const answer = await collectResponse(createCouncilClient(id), baseMessages, controller.signal);
        agents[index]!.line.content = `AGENT · ${id} · DONE\n${answer || "(empty response)"}`;
        return { id, answer: answer || "(empty response)" };
      } catch (error) {
        if (controller.signal.aborted) throw error;
        const message = error instanceof Error ? error.message : String(error);
        agents[index]!.line.content = `AGENT · ${id} · ERROR\n${message}`;
        return { id, answer: `Agent error: ${message}` };
      }
    }));
    if (firstPass.every((item) => item.answer.startsWith("Agent error:"))) {
      throw new Error("All council agents failed. Check model IDs and provider access.");
    }
    setStatus("Council · agents reviewing each other…");
    const reviews = await Promise.all(firstPass.map(async (agent, index) => {
      agents[index]!.line.content += "\n\nPEER REVIEW · Reviewing other agents…";
      const peers = firstPass.filter((item) => item.id !== agent.id).map((item) => `### ${item.id}\n${item.answer}`).join("\n\n");
      const reviewPrompt: ChatMessage[] = [
        { role: "system", content: "You are a rigorous peer reviewer. Identify factual gaps, flawed reasoning, missing constraints, and useful ideas in peer answers. Be concise and constructive. Do not merely agree." },
        { role: "user", content: `Original user request:\n${content}\n\nYour first answer:\n${agent.answer}\n\nPeer answers:\n${peers}\n\nGive your critique and any corrected insight.` },
      ];
      try {
        const review = await collectResponse(createCouncilClient(agent.id), reviewPrompt, controller.signal);
        agents[index]!.line.content += `\n\nPEER REVIEW\n${review}`;
        return { id: agent.id, review: review || "No review returned." };
      } catch (error) {
        if (controller.signal.aborted) throw error;
        const message = error instanceof Error ? error.message : String(error);
        agents[index]!.line.content += `\n\nPEER REVIEW ERROR\n${message}`;
        return { id: agent.id, review: `Review error: ${message}` };
      }
    }));
    setStatus("Council · synthesizing final answer…");
    const synthesis: ChatMessage[] = [
      { role: "system", content: "You are the final synthesis editor. Combine the strongest supported ideas, resolve disagreements explicitly, flag uncertainty, and answer the user's request directly. Do not claim consensus when agents disagree." },
      { role: "user", content: `User request:\n${content}\n\nInitial answers:\n${firstPass.map((item) => `## ${item.id}\n${item.answer}`).join("\n\n")}\n\nPeer reviews:\n${reviews.map((item) => `## ${item.id}\n${item.review}`).join("\n\n")}\n\nProduce the final answer.` },
    ];
    const finalLine = addLine("AKANE · FINAL SYNTHESIS", "Synthesizing…", "#F2A6C7");
    const finalAnswer = await collectResponse(createClientForModel(model), synthesis, controller.signal);
    finalLine.content = `AKANE · FINAL SYNTHESIS\n${finalAnswer || "(empty synthesis)"}`;
    history.messages.push({ role: "assistant", content: `Multi-model review (${selected.join(", ")})\n\n${finalAnswer}` });
    await saveHistory();
    setStatus(`Council complete · ${selected.length} agents · 2 review stages`);
  } catch (error) {
    const message = controller.signal.aborted ? "Council cancelled." : error instanceof Error ? error.message : String(error);
    addLine("COUNCIL", message, "#FF8A8A");
    setStatus(controller.signal.aborted ? "Council cancelled" : "Council failed");
  } finally {
    if (activeRequest === controller) activeRequest = undefined;
    input.focus();
  }
}

async function sendMessage(raw: string): Promise<void> {
  const content = raw.trim();
  if (!content) return;
  if (content === "/help") {
    addLine("HELP", "/status                 show active configuration\n/providers              list supported providers\n/provider <id> [model]  select and save provider\n/connect <url> <model>  use a custom endpoint\n/models [filter]        list/filter provider models\n/model <id>             switch model\n/council <a,b,...>     enable multi-model review (max 4)\n/council off            disable multi-model review\n/new                    start a fresh conversation\n/chats                  list saved conversations\n/switch <id-prefix>     switch conversation\n/clear                  clear only the current conversation\n/help                   show this help\n/quit                   exit AkaneChat", "#AAB4C5");
    return;
  }
  if (content === "/status") {
    addLine("ACTIVE CONFIGURATION", `Provider: ${providerName} (${providerId || "none"})\nModel: ${model || "none"}\nEndpoint: ${baseUrl || "none"}\nCouncil: ${councilModels.length ? councilModels.join(", ") : "off"}`, "#AAB4C5");
    return;
  }
  if (content === "/providers") {
    const lines = PROVIDER_REGISTRY.map((item) => `${item.id.padEnd(12)} ${item.name}${item.id === providerId ? "  ← active" : ""}\n             ${item.description}`);
    addLine("SUPPORTED PROVIDERS", lines.join("\n\n"), "#AAB4C5");
    addLine("NOTE", "Anthropic and Gemini use native adapters. Custom endpoints must expose the OpenAI Chat Completions API.", "#AAB4C5");
    return;
  }
  if (content.startsWith("/provider ")) {
    const [idRaw, ...modelParts] = content.slice(10).trim().split(/\s+/);
    const id = idRaw?.toLowerCase() ?? "";
    const requestedModel = modelParts.join(" ");
    const definition = getProviderDefinition(id);
    if (!definition) {
      addLine("USAGE", `/provider <${PROVIDER_REGISTRY.map((item) => item.id).join("|")}>`, "#F2A6C7");
      return;
    }
    const env = {
      AKANECHAT_PROVIDER: id,
      AKANECHAT_BASE_URL: id === "custom" ? baseUrl || undefined : undefined,
      AKANECHAT_API_KEY: process.env.AKANECHAT_API_KEY,
      AKANECHAT_MODEL: requestedModel || model || savedSettings?.model,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      GROQ_API_KEY: process.env.GROQ_API_KEY,
      OLLAMA_API_KEY: process.env.OLLAMA_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    };
    try {
      const resolved = resolveProviderEnvironment(env);
      if (!resolved) {
        addLine("SETUP REQUIRED", `Choose a model immediately: /provider ${id} <model-id>. Hosted providers also need ${definition.apiKeyEnv ?? "a key"} in the environment.`, "#F2A6C7");
        return;
      }
      baseUrl = resolved.config.baseUrl;
      apiKey = resolved.config.apiKey;
      model = resolved.config.model;
      providerName = definition.name;
      providerId = definition.id;
      client = createProviderClient(resolved);
      configured = true;
      providerInfo.content = `${providerName}\n${baseUrl}\n\nModel\n${model}`;
      setStatus(`Provider selected · ${providerName} · ${model}`);
      await persistProviderSettings();
      addLine("SYSTEM", `Selected ${providerName}. Model: ${model}. Preferences saved locally; credentials remain in environment variables.`, "#AAB4C5");
    } catch (error) {
      addLine("PROVIDER CONFIG ERROR", error instanceof Error ? error.message : String(error), "#FF8A8A");
    }
    return;
  }
  if (content === "/models") return listModels();
  if (content.startsWith("/models ")) return listModels(content.slice(8).trim());
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
      providerId = "custom";
      client = nextClient;
      configured = true;
      providerInfo.content = `${providerName}\n${baseUrl}\n\nModel\n${model}\n\nConnected for this session`;
      setStatus(`Provider configured · ${model}`);
      await persistProviderSettings();
      addLine("SYSTEM", `Provider target set to ${baseUrl} with model ${model}. API key remains sourced from environment variables.`, "#AAB4C5");
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
    client = createClientForModel(model);
    providerInfo.content = `${providerName}\n${baseUrl}\n\nModel\n${model}`;
    setStatus(`Model selected · ${model}`);
    await persistProviderSettings();
    addLine("SYSTEM", `Model changed to ${model} and saved locally.`, "#AAB4C5");
    return;
  }
  if (content === "/council off") {
    councilModels = [];
    councilInfo.content = "Off";
    await persistProviderSettings();
    addLine("COUNCIL", "Multi-model review disabled.", "#AAB4C5");
    return;
  }
  if (content.startsWith("/council ")) {
    const selected = content.slice(9).split(",").map((item) => item.trim()).filter(Boolean);
    if (selected.length < 2 || selected.length > 4 || new Set(selected).size !== selected.length) {
      addLine("USAGE", "/council <model-a,model-b[,model-c,model-d]>  (2–4 distinct models)\nUse provider::model for cross-provider agents.\n/council off", "#F2A6C7");
      return;
    }
    if (!client) {
      addLine("SYSTEM", "Select and configure a provider before enabling council mode.", "#F2A6C7");
      return;
    }
    councilModels = selected;
    councilInfo.content = `${selected.length} agents\n${selected.join("\n")}`;
    await persistProviderSettings();
    addLine("COUNCIL", `Enabled with ${selected.length} models: ${selected.join(", ")}\nEach request runs in parallel, followed by one peer-review round and a final synthesis.`, "#AAB4C5");
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

  if (councilModels.length >= 2) return sendCouncil(content);

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
