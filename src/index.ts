#!/usr/bin/env bun
import { homedir } from "node:os";
import { saveGeneratedMedia } from "./media-output";
import { join } from "node:path";
import { loadConversationStore, saveConversationStore, createConversation, getActiveConversation, switchConversation } from "./storage/conversations";
import { loadSettings, saveSettings } from "./storage/settings";
import { addMemory, forgetMemory, formatMemoryContext, loadMemory, saveMemory, selectRelevantMemories } from "./storage/memory";
import { createTask, deleteTask, formatTask, loadTasks, saveTasks, updateTask, updateTaskStep, recoverInterruptedTasks, type TaskStatus } from "./storage/tasks";
import {
  BoxRenderable,
  InputRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  createCliRenderer,
} from "@opentui/core";
import { getProviderDefinition, PROVIDER_REGISTRY, resolveProviderEnvironment } from "./providers/registry";
import { createAnthropicClient, createGeminiClient } from "./providers/native";
import { checkModel, shouldFailover } from "./provider-health";
import { listWorkspaceDirectories, type WorkspaceEntry } from "./workspace";
import { applyWorkspaceWrite, executeWorkspaceReadTool, getAvailableWorkspaceToolDefinitions, getUnsupportedWorkspaceTool, WORKSPACE_TOOL_DEFINITIONS, type PendingWorkspaceWrite, type WorkspaceToolName } from "./workspace-tools";
import { buildAgentSystemPrompt } from "./agent-core";
import { createToolController } from "./tool-controller";
import { pruneContext } from "./context-pruner";
import { buildCoordinatorInstructions, createCoordinatedPlan } from "./coordinator";
import { buildAutomaticContext, buildIntentPolicy, classifyAutomaticIntent } from "./intent-router";
import { BUILTIN_PERSONAS, buildPersonaPrompt, detectPersonaSwitch, formatPersonaRoster, loadPersonaMemories, savePersonaMemory, type PersonaDefinition } from "./personas";
import { assignPersonaModel, getPersonaModel, parsePersonaModelAssignment, type PersonaModelMap } from "./persona-models";
import { inferRequiredCapability, parseCapabilityList, type ModelCapability } from "./capability-router";
import { generateWithMediaFallback } from "./media-adapters";
import { removeModelCapabilities, setModelCapabilities } from "./model-capabilities";
import { loadMediaAdapters } from "./media-config";
import { buildSpecialistInstructions, selectSpecialists } from "./specialists";
import { beginExecutionStep, finishExecutionStep, nextExecutionDecision, resumeBlockedStep } from "./execution-engine";
import { buildReviewPrompt, classifyReviewVerdict } from "./reviewer";
import { captureWorkspaceSnapshot, diffWorkspaceSnapshots } from "./file-change-tracker";
import { evaluateCompletionGate } from "./completion-gate";
import { runTerminalCheck, TERMINAL_CHECKS } from "./terminal-executor";
import { sanitizeEvidenceSummary } from "./evidence-engine";
import { createJobStore, enqueueJob, loadJobStore, recoverJobs, claimJob, checkpointJob, finishJob, resumeJob, withJobStoreTransaction } from "./background-runner";
import { acquireWorkerLock } from "./worker-lock";
import { runParallelAgents } from "./parallel-agents";
import { runAutonomousLoop } from "./autonomous-loop";
import { DEFAULT_RESOURCE_BUDGET, isWithinJobBudget } from "./resource-manager";
import { customProviderDefinition, getCustomProvider, listCustomProviders, normalizeCustomProviderId, saveCustomProvider } from "./custom-providers";
import {
  createOpenAICompatibleClient,
  type ChatMessage,
  type ModelInfo,
  type ToolChatMessage,
  ProviderError,
} from "./providers/openai-compatible";

const dataDirectory = join(homedir(), ".local", "share", "akanechat");
const settingsPath = join(dataDirectory, "settings.json");
const envPath = join(process.cwd(), ".env");
const savedSettings = await loadSettings(settingsPath);
let modelCapabilities: Record<string, string[]> = { ...(savedSettings?.modelCapabilities ?? {}) };
let startupConfigError: string | undefined;
const initialProvider = (() => {
  try {
    const selectedAtStartup = process.env.AKANECHAT_PROVIDER ?? savedSettings?.provider;
    if (selectedAtStartup && !getProviderDefinition(selectedAtStartup)) {
      const custom = getCustomProvider(selectedAtStartup);
      const selectedModel = process.env.AKANECHAT_MODEL ?? savedSettings?.model ?? custom?.model;
      if (custom && selectedModel) return { definition: customProviderDefinition(custom), config: { baseUrl: custom.baseUrl, apiKey: custom.apiKey, model: selectedModel }, source: "registry" as const };
    }
    return resolveProviderEnvironment({
      AKANECHAT_PROVIDER: selectedAtStartup,
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
  chatWithTools?(messages: ToolChatMessage[], tools: readonly unknown[], signal?: AbortSignal): Promise<{ content: string; toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> }>;
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
let activePersonaId = savedSettings?.activePersona ?? "akane";
let personaModels: PersonaModelMap = savedSettings?.personaModels ?? {};
let fallbackModels: string[] = savedSettings?.fallbackModels ?? [];
let workspacePath = savedSettings?.workspace ?? homedir();
let workspaceToolsEnabled = savedSettings?.workspaceTools ?? true;
const disabledWorkspaceTools = new Map<string, Set<WorkspaceToolName>>();
const workspaceToolCallingUnavailable = new Set<string>();
function workspaceCapabilityKey(): string { return `${providerId}::${baseUrl}::${model}`; }
let workspacePicker: { entries: WorkspaceEntry[]; selected: number; offset: number; line: TextRenderable } | undefined;
const WORKSPACE_PICKER_ROWS = 8;
let providerWizard: { step: "id" | "base-url" | "api-key" | "model"; id?: string; name?: string; baseUrl?: string; apiKey?: string; models?: ModelInfo[] } | undefined;
let pendingApproval: { path: string; existed: boolean; resolve: (approved: boolean) => void } | undefined;

function createClientForModel(modelId: string): ChatProviderClient {
  const custom = getCustomProvider(providerId);
  const definition = getProviderDefinition(providerId) ?? (custom ? customProviderDefinition(custom) : undefined);
  if (!definition) throw new Error("Select a provider first.");
  return createProviderClient({
    definition,
    config: { baseUrl: custom?.baseUrl ?? baseUrl, apiKey: custom?.apiKey ?? apiKey, model: modelId },
    source: "registry",
  });
}

function createCouncilClient(specification: string): ChatProviderClient {
  const separator = specification.indexOf("::");
  if (separator < 0) return createClientForModel(specification);
  const selectedId = specification.slice(0, separator).trim().toLowerCase();
  const selectedModel = specification.slice(separator + 2).trim();
  const custom = getCustomProvider(selectedId);
  const definition = getProviderDefinition(selectedId) ?? (custom ? customProviderDefinition(custom) : undefined);
  if (!definition || !selectedModel) throw new Error(`Invalid council agent '${specification}'. Use provider::model.`);
  if (custom) return createProviderClient({ definition, config: { baseUrl: custom.baseUrl, apiKey: custom.apiKey, model: selectedModel }, source: "registry" });
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
const memoryPath = join(dataDirectory, "memory.json");
const memoryStore = await loadMemory(memoryPath);
const taskPath = join(dataDirectory, "tasks.json");
const jobPath = join(dataDirectory, "jobs.json");
const workerLockPath = join(dataDirectory, "worker.lock");
let backgroundRunnerActive = false;
const taskStore = await loadTasks(taskPath);
if (recoverInterruptedTasks(taskStore) > 0) await saveTasks(taskPath, taskStore);
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
      ...(fallbackModels.length ? { fallbackModels } : {}),
      workspace: workspacePath,
      workspaceTools: workspaceToolsEnabled,
      activePersona: activePersonaId,
      ...(Object.keys(personaModels).length ? { personaModels } : {}),
      ...(Object.keys(modelCapabilities).length ? { modelCapabilities } : {}),
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
sidebar.add(new TextRenderable(renderer, { content: "WORKSPACE\n" + workspacePath, fg: "#F2A6C7" }));
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
sidebar.add(new TextRenderable(renderer, { content: "/providers list providers\n/provider  choose provider\n/provider add  add endpoint\n/models    list models\n/model     choose model\n/remember <note> save memory\n/memory    list memories\n/forget <id> delete memory\n/tasks     list saved tasks\n/task create <title> create task\n/task plan <id> <a | b> add steps\n/task step <id> <step> <status> update step\n/task status <id> inspect task\n/task run <id> run next stage\n/task review <id> read-only review\n/task verify <id> inspect evidence gate\n/terminal <typecheck|test|build|diff> run fixed approved check\n/task resume <id> <step> retry blocked stage\n/task cancel <id> cancel task\n/task delete <id> delete task\n/new       new chat\n/chats     chat history\n/help      show help", fg: "#8792A5" }));

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

function startThinkingIndicator(line: TextRenderable): { stop: () => void } {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const activities = ["Akane sedang berpikir", "Menganalisis permintaan", "Menunggu respons model"];
  let frame = 0;
  let activity = 0;
  let stopped = false;
  const render = () => {
    line.content = `${frames[frame % frames.length]} ${activities[activity]}…`;
    frame += 1;
    if (frame % frames.length === 0) activity = (activity + 1) % activities.length;
  };
  render();
  const timer = setInterval(render, 100);
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}

function askWriteApproval(write: PendingWorkspaceWrite): Promise<boolean> {
  return new Promise((resolve) => {
    pendingApproval = { path: write.path, existed: write.existed, resolve };
    const preview = write.content.split("\n").slice(0, 12).join("\n");
    addLine("FILE CHANGE APPROVAL", `${write.existed ? "Replace" : "Create"} ${write.path} (${write.content.length} chars)\n\n${preview}${write.content.split("\n").length > 12 ? "\n… preview truncated" : ""}\n\nType yes to apply or no to reject.`, "#F2A6C7");
    input.placeholder = "Approve file change? type yes / no…";
    setStatus("Waiting for explicit file-write approval");
    input.focus();
  });
}

function addLine(label: string, content: string, color = "#D8DEE9"): TextRenderable {
  const secrets = [apiKey, providerWizard?.apiKey].filter((value): value is string => Boolean(value));
  let safeContent = content;
  for (const secret of secrets) safeContent = safeContent.split(secret).join("[REDACTED]");
  const line = new TextRenderable(renderer, { content: `${label}\n${safeContent}`, fg: color });
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

async function openWorkspacePicker(): Promise<void> {
  try {
    const home = homedir();
    const directories = await listWorkspaceDirectories(home);
    const entries: WorkspaceEntry[] = [
      { name: workspacePath === home ? "✓ Use home directory" : "Use home directory", path: home, directory: true },
      ...(workspacePath !== home ? [{ name: "✓ Keep current · " + workspacePath, path: workspacePath, directory: true }] : []),
      ...directories,
    ];
    const selected = Math.max(0, entries.findIndex((entry) => entry.path === workspacePath));
    const line = addLine("SELECT WORKSPACE", "", "#AAB4C5");
    workspacePicker = { entries, selected, offset: Math.max(0, selected - WORKSPACE_PICKER_ROWS + 1), line };
    renderWorkspacePicker();
    setStatus("Choose a workspace · ↑ ↓ navigate · Enter select");
  } catch (error) {
    addLine("WORKSPACE PICKER", error instanceof Error ? error.message : String(error), "#FF8A8A");
  }
}

function selectWorkspace(): void {
  if (!workspacePicker) return;
  const entry = workspacePicker.entries[workspacePicker.selected];
  if (!entry) return;
  workspacePath = entry.path;
  workspacePicker.line.content += "\n\nSelected workspace: " + workspacePath;
  workspacePicker = undefined;
  void persistProviderSettings();
  setStatus("Workspace selected · " + workspacePath);
}

function renderWorkspacePicker(): void {
  if (!workspacePicker) return;
  const { entries, selected } = workspacePicker;
  const maxOffset = Math.max(0, entries.length - WORKSPACE_PICKER_ROWS);
  workspacePicker.offset = Math.min(maxOffset, Math.max(0, selected < workspacePicker.offset
    ? selected
    : selected >= workspacePicker.offset + WORKSPACE_PICKER_ROWS
      ? selected - WORKSPACE_PICKER_ROWS + 1
      : workspacePicker.offset));
  const visible = entries.slice(workspacePicker.offset, workspacePicker.offset + WORKSPACE_PICKER_ROWS);
  const first = workspacePicker.offset + 1;
  const last = workspacePicker.offset + visible.length;
  workspacePicker.line.content = [
    "WORKSPACE · ↑ ↓ navigate · Enter select · Esc keep current",
    `Folders ${first}-${last} of ${entries.length} · ${selected + 1}/${entries.length}`,
    ...(workspacePicker.offset > 0 ? ["  ↑ more folders above"] : []),
    ...visible.map((entry, index) => {
      const actualIndex = workspacePicker!.offset + index;
      return (actualIndex === selected ? "▶" : " ") + " 📁 " + entry.name;
    }),
    ...(workspacePicker.offset + visible.length < entries.length ? ["  ↓ more folders below"] : []),
  ].join("\n");
}
void openWorkspacePicker();

async function checkStartupModel(): Promise<void> {
  if (!client) return;
  setStatus(`Checking ${providerName} · ${model}…`);
  const result = await checkModel(client);
  if (result.ok) {
    addLine("MODEL HEALTH", `${model} · WORKING`, "#8FD7A5");
    setStatus(`Ready · ${providerName} · ${model}`);
    return;
  }
  addLine("MODEL HEALTH", `${model} · FAILED · ${result.reason ?? "Unknown error"}`, "#FF8A8A");

  // If the configured default fails, discover models exposed by this exact BASE_URL
  // and probe them sequentially with a real, minimal chat request.
  addLine("MODEL SCAN", `Default model unavailable. Scanning ${baseUrl}/models …`, "#F2C879");
  setStatus(`Scanning models from ${baseUrl} …`);
  try {
    const discovered = await client.listModels();
    const candidates = discovered
      .map((item) => item.id?.trim())
      .filter((id): id is string => Boolean(id) && id !== model);
    addLine("MODEL SCAN", `Endpoint returned ${discovered.length} model(s); testing ${candidates.length} alternative(s), one by one.`, "#AAB4C5");
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index]!;
      setStatus(`Testing discovered model ${index + 1}/${candidates.length} · ${candidate} …`);
      addLine("MODEL TEST", `[${index + 1}/${candidates.length}] Testing ${candidate} …`, "#F2C879");
      const candidateClient = createClientForModel(candidate);
      const health = await checkModel(candidateClient);
      if (!health.ok) {
        addLine("MODEL TEST", `[${index + 1}/${candidates.length}] ${candidate} · FAILED · ${health.reason ?? "Unavailable"}`, "#FF8A8A");
        continue;
      }
      client = candidateClient;
      model = candidate;
      providerInfo.content = `${providerName}\n${baseUrl}\n\nModel\n${model}`;
      await persistProviderSettings();
      addLine("MODEL TEST", `[${index + 1}/${candidates.length}] ${candidate} · WORKING`, "#8FD7A5");
      addLine("AUTO MODEL SELECT", `Selected ${providerId}::${model}; saved as the new default.`, "#8FD7A5");
      setStatus(`Ready · ${providerName} · ${model}`);
      return;
    }
    if (!candidates.length) addLine("MODEL SCAN", "No alternative model IDs were returned by this endpoint.", "#FF8A8A");
    else addLine("MODEL SCAN", `All ${candidates.length} discovered alternatives failed the chat test.`, "#FF8A8A");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    addLine("MODEL SCAN FAILED", `Could not list/test models from ${baseUrl}: ${reason}`, "#FF8A8A");
  }

  if (!result.retryable) {
    setStatus("Default and discovered models unavailable; automatic fallback skipped for this permanent error");
    return;
  }
  for (const specification of fallbackModels.slice(0, 3)) {
    try {
      const fallbackClient = createCouncilClient(specification);
      setStatus(`Primary unavailable · checking fallback ${specification}…`);
      const health = await checkModel(fallbackClient);
      if (!health.ok) {
        addLine("FALLBACK", `${specification} · FAILED · ${health.reason ?? "Unavailable"}`, "#FF8A8A");
        continue;
      }
      const separator = specification.indexOf("::");
      const nextProvider = separator > 0 ? specification.slice(0, separator) : providerId;
      const nextModel = separator > 0 ? specification.slice(separator + 2) : specification;
      const definition = getProviderDefinition(nextProvider);
      client = fallbackClient;
      providerId = nextProvider;
      providerName = definition?.name ?? nextProvider;
      model = nextModel;
      if (definition?.baseUrl) baseUrl = definition.baseUrl;
      apiKey = definition?.apiKeyEnv ? process.env[definition.apiKeyEnv] : process.env.AKANECHAT_API_KEY;
      providerInfo.content = `${providerName}\n${baseUrl}\n\nModel\n${model}`;
      await persistProviderSettings();
      addLine("AUTO FAILOVER", `Switched to ${providerId}::${model} · WORKING`, "#8FD7A5");
      setStatus(`Ready · fallback ${providerName} · ${model}`);
      return;
    } catch (error) {
      addLine("FALLBACK ERROR", `${specification} · ${error instanceof Error ? error.message : String(error)}`, "#FF8A8A");
    }
  }
  setStatus("No working model · configure a fallback or choose another provider");
}
void checkStartupModel();

interface ModelChoice { id: string; ok: boolean; checked: boolean; reason?: string }
let modelPicker: { choices: ModelChoice[]; selected: number; line: TextRenderable } | undefined;

function renderModelPicker(): void {
  if (!modelPicker) return;
  modelPicker.line.content = [
    "MODEL SELECTOR · ↑ ↓ navigate · Enter activate · Esc close",
    ...modelPicker.choices.map((choice, index) => {
      const marker = index === modelPicker!.selected ? "▶" : " ";
      const state = !choice.checked ? "◌ UNCHECKED" : choice.ok ? "● WORKING" : "○ FAILED";
      return `${marker} ${state.padEnd(11)} ${choice.id}${choice.reason ? ` · ${choice.reason}` : ""}`;
    }),
  ].join("\n");
}

async function openModelPicker(): Promise<void> {
  if (!client) {
    addLine("SYSTEM", "Configure a provider first.", "#F2A6C7");
    return;
  }
  setStatus("Loading model catalogue…");
  try {
    const catalogue = (await client.listModels()).slice(0, 60);
    if (!catalogue.length) throw new Error("No models were returned by the provider.");
    const choices: ModelChoice[] = catalogue.map((item) => ({
      id: item.id,
      ok: item.id === model,
      checked: item.id === model,
    }));
    if (model && !choices.some((item) => item.id === model)) {
      choices.unshift({ id: model, ok: true, checked: true });
    }
    const currentIndex = choices.findIndex((item) => item.id === model);
    const line = addLine("MODEL SELECTOR", "", "#AAB4C5");
    modelPicker = { choices, selected: Math.max(0, currentIndex), line };
    renderModelPicker();
    setStatus(`${choices.length} models loaded · select one to run its health check`);
  } catch (error) {
    addLine("MODEL DISCOVERY FAILED", error instanceof Error ? error.message : String(error), "#FF8A8A");
    setStatus("Could not open model selector");
  }
}

async function activatePickedModel(): Promise<void> {
  if (!modelPicker) return;
  const choice = modelPicker.choices[modelPicker.selected];
  if (!choice) return;
  const nextClient = createClientForModel(choice.id);
  setStatus(`Testing selected model · ${choice.id}…`);
  const health = await checkModel(nextClient);
  choice.checked = true;
  choice.ok = health.ok;
  choice.reason = health.reason;
  if (!health.ok) {
    renderModelPicker();
    setStatus("Model check failed · previous model remains active · Enter to retry");
    addLine("MODEL FAILED", `${choice.id} · ${health.reason ?? "Unavailable"}. Previous model remains active; select again to retry.`, "#FF8A8A");
    return;
  }
  model = choice.id;
  client = nextClient;
  providerInfo.content = `${providerName}\n${baseUrl}\n\nModel\n${model}`;
  modelPicker.line.content += "\n\nActivated · WORKING";
  modelPicker = undefined;
  await persistProviderSettings();
  setStatus(`Model selected · ${model}`);
  addLine("SYSTEM", `Model changed to ${model} · WORKING.`, "#8FD7A5");
}

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

async function collectWorkspaceAgent(target: ChatProviderClient, messages: ChatMessage[], signal: AbortSignal, onWrite?: () => void): Promise<{ text: string; evidence: readonly import("./storage/tasks").TaskEvidence[] }> {
  if (!target.chatWithTools) {
    addLine("WORKSPACE AUTO", `This provider adapter does not expose tool calling for ${model}. Continuing with ordinary chat; workspace tools remain available for compatible providers.`, "#F2A6C7");
    let output = "";
    for await (const chunk of target.streamChat(messages, signal)) output += chunk;
    return { text: output, evidence: [] };
  }
  const requestText = messages.map((message) => message.content).join("\n");
  const memoryContext = formatMemoryContext(selectRelevantMemories(await loadMemory(memoryPath), requestText));
  const automaticContext = await getAutomaticContext(requestText);
  const specialistAssignments = selectSpecialists(requestText, workspaceToolsEnabled);
  if (specialistAssignments.length) {
    addLine("SPECIALIST ROUTING", specialistAssignments.map((item, index) => `${index + 1}. ${item.role.toUpperCase()} — ${item.purpose}`).join("\n"), "#AAB4C5");
  }
  const conversation: ToolChatMessage[] = pruneContext([
    { role: "system", content: [buildAgentSystemPrompt({ workspacePath, maxToolCalls: 64 }), buildCoordinatorInstructions(), buildIntentPolicy(), buildSpecialistInstructions(specialistAssignments), memoryContext, automaticContext].filter(Boolean).join("\n\n") },
    ...messages.map((message) => ({ role: message.role, content: message.content })),
  ]);
  // A request can span four internal batches; the guard is cumulative across all of them.
  const toolController = createToolController({ maxCalls: 64, maxRepeatedCalls: 2 });
  const capabilityKey = workspaceCapabilityKey();
  if (workspaceToolCallingUnavailable.has(capabilityKey)) {
    let output = "";
    for await (const chunk of target.streamChat(messages, signal)) output += chunk;
    return { text: output, evidence: toolController.evidence.list() };
  }
  let disabled = disabledWorkspaceTools.get(capabilityKey) ?? new Set<WorkspaceToolName>();
  disabledWorkspaceTools.set(capabilityKey, disabled);
  let finalText = "";
  const maxToolRounds = 32;
  const roundsPerBatch = 8;
  for (let round = 0; round < maxToolRounds; round++) {
    if (signal.aborted) throw new Error("Generation cancelled.");
    if (round > 0 && round % roundsPerBatch === 0) {
      addLine("WORKSPACE AUTO", `Continuing automatically · batch ${round / roundsPerBatch + 1}/4 · ${toolController.stats().totalCalls} tool calls used`, "#AAB4C5");
    }
    const availableTools = getAvailableWorkspaceToolDefinitions(disabled);
    if (availableTools.length === 0) {
      workspaceToolCallingUnavailable.add(capabilityKey);
      addLine("WORKSPACE AUTO", "All workspace tools are unsupported by this model. Continuing with normal chat; tools remain available for compatible models.", "#F2A6C7");
      let output = "";
      for await (const chunk of target.streamChat(messages, signal)) output += chunk;
      return { text: finalText + output, evidence: toolController.evidence.list() };
    }
    let result;
    try {
      const boundedConversation = pruneContext(conversation);
      result = await target.chatWithTools(boundedConversation, availableTools, signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const unsupportedTool = getUnsupportedWorkspaceTool(error);
      if (unsupportedTool && availableTools.some((definition) => definition.function.name === unsupportedTool)) {
        const toolName = unsupportedTool;
        disabled.add(toolName);
        addLine("WORKSPACE AUTO", `${toolName} is unsupported by ${model}; disabled for this model. Retrying with the remaining workspace tools.`, "#F2A6C7");
        round--;
        continue;
      }
      if (/no endpoints found.*support tool use|tool.?calling.*not supported|does not support.*tool/i.test(message)) {
        workspaceToolCallingUnavailable.add(capabilityKey);
        addLine("WORKSPACE AUTO", `This model does not support tool calling. Workspace tools are temporarily disabled for ${model}; continuing with normal chat.`, "#F2A6C7");
        let output = "";
        for await (const chunk of target.streamChat(messages, signal)) output += chunk;
        return { text: finalText + output, evidence: toolController.evidence.list() };
      }
      throw error;
    }
    finalText += result.content;
    if (!result.toolCalls.length) return { text: finalText, evidence: toolController.evidence.list() };
    conversation.push({
      role: "assistant", content: result.content || null,
      tool_calls: result.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })),
    });
    for (const call of result.toolCalls) {
      const decision = toolController.check(call.name, call.arguments);
      if (!decision.allowed) {
        conversation.push({ role: "tool", tool_call_id: call.id, content: `Blocked by agent safety controller: ${decision.reason}` });
        continue;
      }
      try {
        const toolResult = await executeWorkspaceReadTool(workspacePath, { name: call.name as WorkspaceToolName, arguments: call.arguments });
        if (typeof toolResult === "string") {
          addLine(`WORKSPACE · ${call.name}`, toolResult.slice(0, 12_000), "#AAB4C5");
          toolController.record(call.name, "succeeded", `Read operation returned ${toolResult.length} characters.`);
          conversation.push({ role: "tool", tool_call_id: call.id, content: toolResult.slice(0, 12_000) });
        } else {
          const approved = await askWriteApproval(toolResult);
          if (!approved) {
            toolController.record(call.name, "rejected", `User rejected proposed change to ${toolResult.path}.`);
            conversation.push({ role: "tool", tool_call_id: call.id, content: "User rejected this file change. Do not retry unless the user asks." });
          } else {
            const writeResult = await applyWorkspaceWrite(workspacePath, toolResult);
            onWrite?.();
            addLine("FILE UPDATED", `${toolResult.path} · ${toolResult.existed ? "replaced" : "created"}${writeResult.backupPath ? `\nBackup: ${writeResult.backupPath}` : ""}`, "#8FD7A5");
            toolController.record(call.name, "succeeded", `User-approved ${toolResult.existed ? "replacement" : "creation"} of ${toolResult.path}; write completed.`);
            conversation.push({ role: "tool", tool_call_id: call.id, content: `Successfully ${toolResult.existed ? "updated" : "created"} ${toolResult.path}.` });
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        toolController.record(call.name, "failed", message);
        conversation.push({ role: "tool", tool_call_id: call.id, content: `Tool error: ${message}` });
      }
    }
    conversation.push({ role: "system", content: toolController.evidence.summary() });
  }
  return { text: finalText || "The bounded workspace execution budget was exhausted before a final answer was returned. Review the evidence and remaining work below.", evidence: toolController.evidence.list() };
}

async function collectWorkspaceAgentWithFallback(
  messages: ChatMessage[],
  signal: AbortSignal,
): Promise<{ text: string; evidence: readonly import("./storage/tasks").TaskEvidence[] }> {
  if (!client) throw new Error("No active provider.");
  const candidates: Array<{ specification: string; target: ChatProviderClient }> = [
    { specification: `${providerId}::${model}`, target: client },
  ];
  for (const specification of fallbackModels.slice(0, 3)) {
    try { candidates.push({ specification, target: createCouncilClient(specification) }); }
    catch (error) { addLine("FALLBACK CONFIG", `${specification} · ${error instanceof Error ? error.message : String(error)}`, "#FF8A8A"); }
  }
  let writeCommitted = false;
  let lastError: unknown;
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index]!;
    try {
      const result = await collectWorkspaceAgent(candidate.target, messages, signal, () => { writeCommitted = true; });
      if (index > 0) {
        const separator = candidate.specification.indexOf("::");
        const nextProvider = separator > 0 ? candidate.specification.slice(0, separator) : providerId;
        const nextModel = separator > 0 ? candidate.specification.slice(separator + 2) : candidate.specification;
        const definition = getProviderDefinition(nextProvider);
        client = candidate.target;
        providerId = nextProvider;
        providerName = definition?.name ?? nextProvider;
        model = nextModel;
        if (definition?.baseUrl) baseUrl = definition.baseUrl;
        apiKey = definition?.apiKeyEnv ? process.env[definition.apiKeyEnv] : process.env.AKANECHAT_API_KEY;
        providerInfo.content = `${providerName}\n${baseUrl}\n\nModel\n${model}`;
        await persistProviderSettings();
        addLine("AUTO FAILOVER", `Workspace request recovered with ${providerId}::${model}`, "#8FD7A5");
      }
      return result;
    } catch (error) {
      lastError = error;
      // Retrying after an approved write could duplicate or conflict with real changes.
      if (signal.aborted || writeCommitted || !shouldFailover(error) || index === candidates.length - 1) throw error;
      addLine("AUTO FAILOVER", `${candidate.specification} failed before any approved write; trying ${candidates[index + 1]!.specification}`, "#F2A6C7");
    }
  }
  throw lastError instanceof Error ? lastError : new Error("All configured workspace models failed.");
}

async function streamWithFallback(
  messages: ChatMessage[],
  signal: AbortSignal,
  onChunk: (chunk: string) => void,
): Promise<void> {
  if (!client) throw new Error("No active provider.");
  const candidates: Array<{ specification: string; target: ChatProviderClient }> = [
    { specification: `${providerId}::${model}`, target: client },
  ];
  for (const specification of fallbackModels.slice(0, 3)) {
    try { candidates.push({ specification, target: createCouncilClient(specification) }); }
    catch (error) { addLine("FALLBACK CONFIG", `${specification} · ${error instanceof Error ? error.message : String(error)}`, "#FF8A8A"); }
  }
  let lastError: unknown;
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index]!;
    let emitted = false;
    try {
      const memoryContext = formatMemoryContext(selectRelevantMemories(memoryStore, messages.map((message) => message.content).join("\n")));
      const agentMessages: ChatMessage[] = pruneContext([
        { role: "system", content: [buildAgentSystemPrompt({ workspacePath, maxToolCalls: 64 }), buildCoordinatorInstructions(), memoryContext].filter(Boolean).join("\n\n") },
        ...messages,
      ]);
      for await (const chunk of candidate.target.streamChat(agentMessages, signal)) {
        emitted = true;
        onChunk(chunk);
      }
      if (index > 0) {
        const separator = candidate.specification.indexOf("::");
        const nextProvider = separator > 0 ? candidate.specification.slice(0, separator) : providerId;
        const nextModel = separator > 0 ? candidate.specification.slice(separator + 2) : candidate.specification;
        const definition = getProviderDefinition(nextProvider);
        client = candidate.target;
        providerId = nextProvider;
        providerName = definition?.name ?? nextProvider;
        model = nextModel;
        if (definition?.baseUrl) baseUrl = definition.baseUrl;
        apiKey = definition?.apiKeyEnv ? process.env[definition.apiKeyEnv] : process.env.AKANECHAT_API_KEY;
        providerInfo.content = `${providerName}\n${baseUrl}\n\nModel\n${model}`;
        await persistProviderSettings();
        addLine("AUTO FAILOVER", `Request recovered with ${providerId}::${model}`, "#8FD7A5");
      }
      return;
    } catch (error) {
      lastError = error;
      if (signal.aborted || emitted || !shouldFailover(error) || index === candidates.length - 1) throw error;
      addLine("AUTO FAILOVER", `${candidate.specification} unavailable; trying ${candidates[index + 1]!.specification}`, "#F2A6C7");
    }
  }
  throw lastError instanceof Error ? lastError : new Error("All configured models failed.");
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
        const persona = BUILTIN_PERSONAS[index % BUILTIN_PERSONAS.length]!;
        const personaMemory = await loadPersonaMemories(dataDirectory, persona.id, content);
        const agentMessages: ChatMessage[] = [{ role: "system", content: buildPersonaPrompt(persona, personaMemory) }, ...baseMessages];
        const answer = await collectResponse(createCouncilClient(id), agentMessages, controller.signal);
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

async function runBackgroundQueue(): Promise<void> {
  if (backgroundRunnerActive || !client) return;
  const jobClient = client;
  backgroundRunnerActive = true;
  const workerLock = await acquireWorkerLock(workerLockPath);
  if (!workerLock) { backgroundRunnerActive = false; setStatus("Background worker already active in another process"); return; }
  try {
    await withJobStoreTransaction(jobPath, (store) => { recoverJobs(store); });
    let active = 0;
    while (active < DEFAULT_RESOURCE_BUDGET.maxConcurrentJobs) {
      const job = await withJobStoreTransaction(jobPath, (store) => {
        const claimed = claimJob(store);
        return claimed ? structuredClone(claimed) : undefined;
      });
      if (!job) break;
      active++;
      const started = Date.now();
      const controller = new AbortController();
      try {
        const loop = await runAutonomousLoop({
          goal: job.goal,
          maxIterations: DEFAULT_RESOURCE_BUDGET.maxRetries + 1,
          signal: controller.signal,
          checkpoint: async (state) => { await withJobStoreTransaction(jobPath, (store) => { const current = store.jobs.find((item) => item.id === job.id); if (!current) throw new Error("Background job disappeared during checkpoint."); checkpointJob(current, JSON.stringify({ iteration: state.iteration, checkpoint: state.checkpoint, feedback: state.lastFeedback }).slice(0, 2000)); }); },
          execute: async (state) => {
            if (!isWithinJobBudget(started, DEFAULT_RESOURCE_BUDGET)) throw new Error("Job time budget exceeded.");
            const prompt: ChatMessage[] = [{ role: "user", content: `AUTONOMOUS JOB (iteration ${state.iteration}/${state.maxIterations}): ${state.goal}\n${state.lastFeedback ? `Previous verification feedback: ${state.lastFeedback}\nRe-inspect current state before acting; avoid duplicating already completed changes.\n` : ""}Work toward this goal using available workspace tools. Inspect first. Never bypass write approval, secrets restrictions, or safety boundaries. Do not claim completion without observable evidence. If blocked or approval is required, stop and explain.` }];
            const result = workspaceToolsEnabled && jobClient.chatWithTools
              ? await collectWorkspaceAgentWithFallback(prompt, controller.signal)
              : { text: await collectResponse(jobClient, prompt, controller.signal), evidence: [] };
            return `${result.text}\n\nRecorded tool evidence: ${result.evidence.length} action(s).`;
          },
          verify: async (_state, output) => {
            if (!isWithinJobBudget(started, DEFAULT_RESOURCE_BUDGET)) return { verdict: "blocked" as const, feedback: "Job time budget exceeded before verification." };
            const review = await collectResponse(jobClient, [
              { role: "system", content: "You are an independent completion verifier. Do not assume the executor is correct. Decide only from the supplied output and evidence. Return exactly JSON: {\"verdict\":\"pass\"|\"revise\"|\"blocked\",\"feedback\":\"concise reason\"}. Use pass only when completion is supported by concrete evidence. Use blocked when approval, missing credentials, unavailable tools, or a safety boundary prevents progress. Otherwise use revise." },
              { role: "user", content: `Goal: ${job.goal}\nExecutor report:\n${output.slice(0, 12000)}\nReturn the verification JSON.` },
            ], controller.signal);
            try {
              const parsed = JSON.parse(review.match(/\{[\s\S]*\}/)?.[0] ?? "") as { verdict?: string; feedback?: string };
              if (["pass", "revise", "blocked"].includes(parsed.verdict ?? "") && typeof parsed.feedback === "string") return { verdict: parsed.verdict as "pass" | "revise" | "blocked", feedback: parsed.feedback.slice(0, 2000) };
            } catch { /* malformed verifier output is not proof of completion */ }
            return { verdict: "revise" as const, feedback: `Verifier returned an invalid decision: ${review.slice(0, 500)}` };
          },
          replan: async (state, feedback) => {
            const revised = await collectResponse(jobClient, [
              { role: "system", content: "You are a replanner. Return a concise revised execution instruction only. Preserve the original user goal, incorporate verifier feedback, avoid repeating completed work, and never weaken safety or approval requirements." },
              { role: "user", content: `Original goal: ${job.goal}\nPrevious instruction: ${state.goal}\nVerifier feedback: ${feedback}\nProduce the next safe execution instruction.` },
            ], controller.signal);
            return revised.trim().slice(0, 2000) || state.goal;
          },
        });
        await withJobStoreTransaction(jobPath, (store) => {
          const current = store.jobs.find((item) => item.id === job.id);
          if (!current) throw new Error("Background job disappeared before completion.");
          if (loop.status === "completed") finishJob(current, "succeeded", loop.output);
          else finishJob(current, "failed", loop.output, `Autonomous loop ${loop.status} after ${loop.iterations} iteration(s): ${loop.events.at(-1)?.detail ?? "verification did not pass"}`);
        });
        addLine(loop.status === "completed" ? "BACKGROUND JOB VERIFIED" : "BACKGROUND JOB NEEDS ATTENTION", `${job.id.slice(0, 8)} · ${job.goal}\n${loop.events.map((event) => `[${event.type}] ${event.detail}`).join("\n")}\n\n${loop.output.slice(0, DEFAULT_RESOURCE_BUDGET.maxOutputChars)}`, loop.status === "completed" ? "#8FD7A5" : "#F2A6C7");
      } catch (error) {
        await withJobStoreTransaction(jobPath, (store) => {
          const current = store.jobs.find((item) => item.id === job.id);
          if (current?.status === "running") finishJob(current, "failed", undefined, error instanceof Error ? error.message : String(error));
        });
        addLine("BACKGROUND JOB FAILED", `${job.id.slice(0, 8)} · ${error instanceof Error ? error.message : String(error)}`, "#FF8A8A");
      }
      await workerLock.heartbeat();
      active--;
    }
  } finally { await workerLock.release(); backgroundRunnerActive = false; }
}

async function runIndependentAgents(goal: string): Promise<void> {
  if (councilModels.length < 2) throw new Error("Configure at least two distinct /council models to run independent parallel agents.");
  const selected = councilModels.slice(0, 4);
  const assignments = selected.map((id, index) => ({ id, role: ["explorer", "researcher", "critic", "planner"][index]!, prompt: `You are an independent ${["explorer", "researcher", "critic", "planner"][index]} agent. Analyze this goal read-only; do not propose that you changed files. Return concise findings, risks, and verifiable recommendations.\nGOAL: ${goal}` }));
  const results = await runParallelAgents(assignments, async (agent, signal) => collectResponse(createCouncilClient(agent.id), [{ role: "system", content: `Independent specialist role: ${agent.role}. Read-only analysis only.` }, { role: "user", content: agent.prompt }], signal), { concurrency: Math.min(4, assignments.length), signal: new AbortController().signal });
  addLine("INDEPENDENT AGENTS", results.map((item) => `${item.agent.role} · ${item.status.toUpperCase()} · ${item.durationMs}ms\n${item.status === "succeeded" ? String(item.value).slice(0, 3000) : item.error}`).join("\n\n"), results.every((item) => item.status === "succeeded") ? "#8FD7A5" : "#F2A6C7");
}

async function getAutomaticContext(query: string): Promise<string> {
  const [freshMemory, freshTasks, freshJobs] = await Promise.all([
    loadMemory(memoryPath), loadTasks(taskPath), loadJobStore(jobPath),
  ]);
  const relevant = selectRelevantMemories(freshMemory, query).map((entry) => entry.text);
  return buildAutomaticContext({ memories: relevant, tasks: freshTasks.tasks, jobs: freshJobs.jobs });
}

async function sendMessage(raw: string): Promise<void> {
  const content = raw.trim();
  if (!content && providerWizard?.step !== "api-key") return;
  if (providerWizard?.step === "id") {
    try {
      providerWizard.id = normalizeCustomProviderId(content);
      providerWizard.name = content.trim();
      providerWizard.step = "base-url";
      addLine("ADD PROVIDER", `Provider ID: ${providerWizard.id}. Now enter its Base URL.`, "#F2A6C7");
      input.placeholder = "Base URL…";
    } catch (error) { addLine("INVALID PROVIDER ID", error instanceof Error ? error.message : String(error), "#FF8A8A"); }
    return;
  }
  if (providerWizard?.step === "base-url") {
    try {
      const parsed = new URL(content);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Only HTTP or HTTPS endpoints are supported.");
      providerWizard.baseUrl = content.replace(/\/+$/, "");
      providerWizard.step = "api-key";
      addLine("PROVIDER SETUP", "Enter API Key. Input is visible while typing, but will not be added to chat history or logs. Leave empty if the endpoint needs no key.", "#F2A6C7");
      input.placeholder = "API Key (visible input; Enter to continue)…";
    } catch (error) {
      addLine("INVALID URL", error instanceof Error ? error.message : String(error), "#FF8A8A");
    }
    return;
  }
  if (providerWizard?.step === "api-key") {
    providerWizard.apiKey = content || undefined;
    const base = providerWizard.baseUrl!;
    const key = providerWizard.apiKey;
    setStatus("Discovering models…");
    try {
      const discovery = createOpenAICompatibleClient({ baseUrl: base, apiKey: key, model: "model-discovery" });
      const models = await discovery.listModels();
      if (!models.length) throw new Error("The endpoint returned no models from /models.");
      providerWizard.models = models.slice(0, 60);
      providerWizard.step = "model";
      addLine("DISCOVERED MODELS", providerWizard.models.map((item, index) => `${index + 1}. ${item.id}`).join("\n"), "#AAB4C5");
      addLine("SELECT MODEL", "Type the number of the model to test and activate. The previous provider stays active until the test succeeds.", "#F2A6C7");
      input.placeholder = "Model number…";
      setStatus(`Found ${models.length} models · choose one`);
    } catch (error) {
      providerWizard = undefined;
      input.placeholder = "Message AkaneChat… (Enter to send)";
      addLine("MODEL DISCOVERY FAILED", error instanceof Error ? error.message : String(error), "#FF8A8A");
      setStatus("Provider setup cancelled");
    }
    return;
  }
  if (providerWizard?.step === "model") {
    const selectedIndex = Number.parseInt(content, 10) - 1;
    const selected = providerWizard.models?.[selectedIndex];
    if (!selected) {
      addLine("INVALID SELECTION", "Choose a valid model number from the list.", "#F2A6C7");
      return;
    }
    const wizard = providerWizard;
    const nextClient = createOpenAICompatibleClient({ baseUrl: wizard.baseUrl!, apiKey: wizard.apiKey, model: selected.id });
    setStatus(`Checking ${selected.id}…`);
    const health = await checkModel(nextClient);
    if (!health.ok) {
      addLine("MODEL FAILED", `${selected.id} · ${health.reason ?? "Health check failed"}. Existing provider remains active.`, "#FF8A8A");
      providerWizard = undefined;
      input.placeholder = "Message AkaneChat… (Enter to send)";
      setStatus("Provider setup cancelled");
      return;
    }
    baseUrl = wizard.baseUrl!;
    apiKey = wizard.apiKey;
    model = selected.id;
    providerName = wizard.name || "Custom endpoint";
    providerId = wizard.id || "custom";
    await saveCustomProvider(envPath, { id: providerId, name: providerName, baseUrl, apiKey, model });
    client = nextClient;
    configured = true;
    providerInfo.content = `${providerName}\n${baseUrl}\n\nModel\n${model}`;
    providerWizard = undefined;
    input.placeholder = "Message AkaneChat… (Enter to send)";
    await persistProviderSettings();
    addLine("PROVIDER READY", `Connected to ${baseUrl} · ${model} · WORKING. Provider configuration and API key are saved in the project .env file (0600 permissions).`, "#8FD7A5");
    setStatus(`Ready · ${providerName} · ${model}`);
    return;
  }
  const automaticIntent = classifyAutomaticIntent(content);
  if (automaticIntent.kind === "memory_save") {
    try {
      const fresh = await loadMemory(memoryPath);
      const entry = addMemory(fresh, automaticIntent.text);
      await saveMemory(memoryPath, fresh);
      addLine("MEMORY AUTO-SAVED", `${entry.text}\nDisimpan karena kamu secara eksplisit meminta untuk mengingatnya.`, "#8FD7A5");
    } catch (error) { addLine("MEMORY NOT SAVED", error instanceof Error ? error.message : String(error), "#FF8A8A"); }
    return;
  }
  if (automaticIntent.kind === "task_status") {
    const [freshTasks, freshJobs] = await Promise.all([loadTasks(taskPath), loadJobStore(jobPath)]);
    const taskLines = freshTasks.tasks.filter((task) => !["completed", "cancelled"].includes(task.status)).slice(-8).map(formatTask);
    const jobLines = freshJobs.jobs.filter((job) => !["succeeded", "cancelled"].includes(job.status)).slice(-8).map((job) => `${job.id.slice(0, 8)} [${job.status}] ${job.goal}${job.checkpoint ? `\n  Checkpoint: ${job.checkpoint}` : ""}`);
    addLine("AUTOMATIC PROGRESS", [...taskLines, ...jobLines].join("\n\n") || "Tidak ada task atau job aktif.", "#AAB4C5");
    return;
  }
  if (automaticIntent.kind === "task_create") {
    try {
      const fresh = await loadTasks(taskPath);
      const plan = createCoordinatedPlan(automaticIntent.goal);
      const task = createTask(fresh, plan.goal, plan.steps);
      await saveTasks(taskPath, fresh);
      if (automaticIntent.background) {
        const job = await withJobStoreTransaction(jobPath, (jobs) => enqueueJob(jobs, automaticIntent.goal));
        addLine("TASK + BACKGROUND JOB CREATED", `${formatTask(task)}\nJob ${job.id.slice(0, 8)} queued.`, "#8FD7A5");
      } else addLine("TASK CREATED AUTOMATICALLY", `${formatTask(task)}\nTask dicatat. AkaneChat tidak akan menjalankan aksi berisiko tanpa izin.`, "#8FD7A5");
    } catch (error) { addLine("AUTOMATIC TASK ERROR", error instanceof Error ? error.message : String(error), "#FF8A8A"); }
    return;
  }
  const modelAssignment = parsePersonaModelAssignment(content);
  if (modelAssignment) {
    try {
      const nextClient = createCouncilClient(modelAssignment.specification);
      const health = await checkModel(nextClient);
      if (!health.ok) throw new Error(health.reason ?? "Model unavailable");
      personaModels = assignPersonaModel(personaModels, modelAssignment.persona, modelAssignment.specification);
      if (activePersonaId === modelAssignment.persona) {
        const separator = modelAssignment.specification.indexOf("::");
        if (separator > 0) {
          const nextProvider = modelAssignment.specification.slice(0, separator);
          const custom = getCustomProvider(nextProvider);
          const definition = getProviderDefinition(nextProvider) ?? (custom ? customProviderDefinition(custom) : undefined);
          if (definition) { providerId = nextProvider; providerName = definition.name; baseUrl = custom?.baseUrl ?? definition.baseUrl ?? baseUrl; apiKey = custom?.apiKey ?? process.env[definition.apiKeyEnv ?? ""] ?? apiKey; }
        }
        model = modelAssignment.specification.slice(modelAssignment.specification.indexOf("::") + 2);
        client = nextClient;
        configured = true;
      }
      await persistProviderSettings();
      addLine("PERSONA MODEL SAVED", `${modelAssignment.persona} → ${modelAssignment.specification}${activePersonaId === modelAssignment.persona ? " · activated" : " · will activate when switched"}.`, "#8FD7A5");
    } catch (error) { addLine("PERSONA MODEL ERROR", error instanceof Error ? error.message : String(error), "#FF8A8A"); }
    return;
  }
  const personaSwitch = detectPersonaSwitch(content);
  if (personaSwitch) {
    const savedModel = getPersonaModel(personaModels, personaSwitch.id);
    let switchNote = `Provider/model retained: ${providerName} · ${model}.`;
    if (savedModel) {
      try {
        const nextClient = createCouncilClient(savedModel);
        const health = await checkModel(nextClient);
        if (!health.ok) throw new Error(health.reason ?? "Model unavailable");
        const separator = savedModel.indexOf("::");
        if (separator > 0) {
          const nextProvider = savedModel.slice(0, separator);
          const custom = getCustomProvider(nextProvider);
          const definition = getProviderDefinition(nextProvider) ?? (custom ? customProviderDefinition(custom) : undefined);
          if (!definition) throw new Error("Provider definition missing");
          providerId = nextProvider; providerName = definition.name; baseUrl = custom?.baseUrl ?? definition.baseUrl ?? baseUrl; apiKey = custom?.apiKey ?? process.env[definition.apiKeyEnv ?? ""] ?? apiKey;
        }
        model = savedModel.slice(savedModel.indexOf("::") + 2); client = nextClient; configured = true;
        switchNote = `Model restored: ${savedModel}.`;
      } catch (error) { switchNote = `Saved model ${savedModel} could not be activated (${error instanceof Error ? error.message : String(error)}); previous model retained.`; }
    }
    activePersonaId = personaSwitch.id;
    await persistProviderSettings();
    providerInfo.content = `${providerName}\n${baseUrl}\n\nModel\n${model}`;
    addLine("PERSONA SWITCHED", `${personaSwitch.name} is now active. ${switchNote} Persona memory remains separate.`, "#8FD7A5");
    return;
  }
  if (/^(?:persona|karakter)\s*\??$/i.test(content)) {
    addLine("PERSONAS", `Active: ${activePersonaId}\n\n${formatPersonaRoster()}\n\nSwitch naturally: “Aku ingin bicara dengan Akari”. Set model: “Untuk Akari gunakan anthropic::claude-opus-5”.`, "#AAB4C5");
    return;
  }
  const requiredCapability = inferRequiredCapability(content);
  if (requiredCapability === "image_generation" || requiredCapability === "video_generation") {
    const adapters = loadMediaAdapters();
    try {
      const result = await generateWithMediaFallback(adapters, requiredCapability, { prompt: content });
      const savedOutput = result.base64
        ? await saveGeneratedMedia(result, join(dataDirectory, "generated"))
        : undefined;
      addLine(requiredCapability === "image_generation" ? "IMAGE GENERATED" : result.pending ? "VIDEO GENERATION PENDING" : "VIDEO REQUEST ACCEPTED", [
        `Provider: ${result.provider}`,
        result.url ? `Output: ${result.url}` : savedOutput ? `Saved: ${savedOutput}` : result.operationId ? `Operation: ${result.operationId}${result.pending ? " (still processing; no output URL yet)" : ""}` : "Provider returned no accessible output URL or file.",
        result.attempts.length ? `Fallbacks: ${result.attempts.map((item) => `${item.adapter} failed`).join(", ")}` : "Primary adapter succeeded.",
      ].join("\n"), "#8FD7A5");
    } catch (error) {
      addLine("MEDIA GENERATION UNAVAILABLE", error instanceof Error ? error.message : String(error), "#FF8A8A");
    }
    return;
  }
  const personaMemoryMatch = content.match(/^(?:ingat|simpan)\s+(?:untuk|buat)\s+(akane|akari|akeno|rias)\s*[:,]?\s*(.+)$/i);
  if (personaMemoryMatch) {
    try { await savePersonaMemory(dataDirectory, personaMemoryMatch[1]!.toLowerCase(), personaMemoryMatch[2]!); addLine("PERSONA MEMORY SAVED", `Saved privately for ${personaMemoryMatch[1]}.`, "#8FD7A5"); }
    catch (error) { addLine("PERSONA MEMORY NOT SAVED", error instanceof Error ? error.message : String(error), "#FF8A8A"); }
    return;
  }
  if (content === "/provider add") {
    providerWizard = { step: "id" };
    addLine("ADD PROVIDER", "Give this endpoint a unique ID (for example: omni-route, local-ai, groq-proxy). You can add as many custom providers as needed.", "#F2A6C7");
    input.placeholder = "Unique provider ID…";
    return;
  }
  if (content === "/help") {
    addLine("HELP", "Just type naturally. AkaneChat automatically routes memory, task, workspace, and job intent.\n\nIngat, ...          save a memory\nKerjakan ...        create a tracked task\n... di background  queue a background job\nApa progresnya?    read active tasks and jobs\n\n/capabilities, /capability set|remove, /status, /provider, /model, /workspace, /tasks, /jobs, /task..., /memory, /new, /chats, /quit", "#AAB4C5");
    return;
  }
  if (content === "/workspace-tools" || content === "/workspace-tools status") {
    addLine("WORKSPACE TOOLS", `AI workspace tools are ${workspaceToolsEnabled ? "ON" : "OFF"}.\nUse /workspace-tools on or /workspace-tools off to change this setting.`, "#AAB4C5");
    return;
  }
  if (content === "/workspace-tools on" || content === "/workspace-tools off") {
    workspaceToolsEnabled = content.endsWith(" on");
    await persistProviderSettings();
    addLine("WORKSPACE TOOLS", `AI workspace tools turned ${workspaceToolsEnabled ? "ON" : "OFF"}. ${workspaceToolsEnabled ? "Models may receive workspace tool definitions when supported." : "Chat requests will not include workspace tool definitions; ordinary chat remains available."}`, "#8FD7A5");
    setStatus(`Workspace tools · ${workspaceToolsEnabled ? "ON" : "OFF"}`);
    return;
  }
  if (content.startsWith("/workspace-tools ")) {
    addLine("USAGE", "/workspace-tools on | off | status", "#F2A6C7");
    return;
  }
  if (content === "/workspace") {
    await openWorkspacePicker();
    return;
  }
  if (content === "/files") {
    try {
      const result = await executeWorkspaceReadTool(workspacePath, { name: "list_files", arguments: {} });
      addLine("WORKSPACE FILES", typeof result === "string" ? result : "No files.", "#AAB4C5");
    } catch (error) { addLine("WORKSPACE ERROR", error instanceof Error ? error.message : String(error), "#FF8A8A"); }
    return;
  }
  if (content === "/status") {
    addLine("ACTIVE CONFIGURATION", `Provider: ${providerName} (${providerId || "none"})\nModel: ${model || "none"}\nEndpoint: ${baseUrl || "none"}\nWorkspace tools: ${workspaceToolsEnabled ? "on" : "off"}\nCouncil: ${councilModels.length ? councilModels.join(", ") : "off"}`, "#AAB4C5");
    return;
  }
  if (content === "/providers") {
    const builtins = PROVIDER_REGISTRY.map((item) => `${item.id.padEnd(16)} ${item.name}${item.id === providerId ? "  ← active" : ""}\n                 ${item.description}`);
    const customs = listCustomProviders().map((item) => `${item.id.padEnd(16)} ${item.name}${item.id === providerId ? "  ← active" : ""}\n                 ${item.baseUrl} · ${item.model}`);
    addLine("SUPPORTED PROVIDERS", [...builtins, ...customs].join("\n\n"), "#AAB4C5");
    addLine("NOTE", "Anthropic and Gemini use native adapters. Custom endpoints must expose the OpenAI Chat Completions API.", "#AAB4C5");
    return;
  }
  if (content.startsWith("/provider ")) {
    const [idRaw, ...modelParts] = content.slice(10).trim().split(/\s+/);
    const id = idRaw?.toLowerCase() ?? "";
    const requestedModel = modelParts.join(" ");
    const customConfig = getCustomProvider(id);
    const definition = getProviderDefinition(id) ?? (customConfig ? customProviderDefinition(customConfig) : undefined);
    if (!definition) {
      addLine("USAGE", `/provider <${[...PROVIDER_REGISTRY.map((item) => item.id), ...listCustomProviders().map((item) => item.id)].join("|")}>`, "#F2A6C7");
      return;
    }
    const env = {
      AKANECHAT_PROVIDER: id,
      AKANECHAT_BASE_URL: customConfig?.baseUrl ?? (id === "custom" ? baseUrl || undefined : undefined),
      AKANECHAT_API_KEY: customConfig?.apiKey ?? process.env.AKANECHAT_API_KEY,
      AKANECHAT_MODEL: requestedModel || customConfig?.model || model || savedSettings?.model,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      GROQ_API_KEY: process.env.GROQ_API_KEY,
      OLLAMA_API_KEY: process.env.OLLAMA_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    };
    try {
      const resolved = customConfig
        ? { definition, config: { baseUrl: customConfig.baseUrl, apiKey: customConfig.apiKey, model: env.AKANECHAT_MODEL! }, source: "registry" as const }
        : resolveProviderEnvironment(env);
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
      addLine("SYSTEM", `Selected ${providerName}. Model: ${model}. Provider selection saved; custom endpoint credentials remain in the project .env file.`, "#AAB4C5");
    } catch (error) {
      addLine("PROVIDER CONFIG ERROR", error instanceof Error ? error.message : String(error), "#FF8A8A");
    }
    return;
  }
  if (content === "/fallback") {
    addLine("FALLBACK MODELS", fallbackModels.length ? fallbackModels.join("\n") : "No fallback models configured. Add one with /fallback add provider::model", "#AAB4C5");
    return;
  }
  if (content.startsWith("/fallback add ")) {
    const specification = content.slice(14).trim();
    if (!specification.includes("::") || fallbackModels.includes(specification) || fallbackModels.length >= 3) {
      addLine("USAGE", "/fallback add provider::model (maximum 3 unique fallback models)", "#F2A6C7");
      return;
    }
    try {
      createCouncilClient(specification);
      fallbackModels.push(specification);
      await persistProviderSettings();
      addLine("FALLBACK", `Added ${specification}. It will be checked at startup and after transient primary failures.`, "#AAB4C5");
    } catch (error) {
      addLine("FALLBACK ERROR", error instanceof Error ? error.message : String(error), "#FF8A8A");
    }
    return;
  }
  if (content.startsWith("/fallback remove ")) {
    const specification = content.slice(17).trim();
    fallbackModels = fallbackModels.filter((item) => item !== specification);
    await persistProviderSettings();
    addLine("FALLBACK", `Removed ${specification} if it was configured.`, "#AAB4C5");
    return;
  }
  if (content === "/capabilities") {
    const entries = Object.entries(modelCapabilities);
    addLine("MODEL CAPABILITIES", entries.length ? entries.map(([id, caps]) => `${id} → ${caps.join(", ")}`).join("\n") : "No explicit capability metadata yet. Use /capability set provider::model chat,vision (only declare capabilities verified from provider documentation or testing).", "#AAB4C5");
    return;
  }
  if (content.startsWith("/capability set ")) {
    const specification = content.slice(16).trim();
    const separator = specification.indexOf(" ");
    const id = separator > 0 ? specification.slice(0, separator) : "";
    const supplied = separator > 0 ? specification.slice(separator + 1).split(",").map((item) => item.trim()) : [];
    try { modelCapabilities = setModelCapabilities(modelCapabilities, id, supplied); }
    catch (error) { addLine("USAGE", `${error instanceof Error ? error.message : String(error)}\n/capability set provider::model chat,vision`, "#F2A6C7"); return; }
    await persistProviderSettings();
    addLine("CAPABILITY SAVED", `${id} → ${modelCapabilities[id]!.join(", ")}. Metadata is explicit; no capability is inferred from the model name.`, "#8FD7A5");
    return;
  }
  if (content.startsWith("/capability remove ")) {
    const id = content.slice(18).trim();
    modelCapabilities = removeModelCapabilities(modelCapabilities, id);
    await persistProviderSettings();
    addLine("CAPABILITY", `Removed metadata for ${id}.`, "#AAB4C5");
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
  if (content === "/model") {
    await openModelPicker();
    return;
  }
  if (content.startsWith("/model ")) {
    const nextModel = content.slice(7).trim();
    if (!nextModel) return;
    if (!client) {
      addLine("SYSTEM", "Connect a provider first with /connect <base-url> <model-id>.", "#F2A6C7");
      return;
    }
    const nextClient = createClientForModel(nextModel);
    setStatus(`Checking model · ${nextModel}…`);
    const health = await checkModel(nextClient);
    if (!health.ok) {
      addLine("MODEL CHECK FAILED", `${nextModel} · ${health.reason ?? "Unavailable"}. Previous model remains active.`, "#FF8A8A");
      setStatus(`Model unchanged · ${model}`);
      return;
    }
    model = nextModel;
    client = nextClient;
    providerInfo.content = `${providerName}\n${baseUrl}\n\nModel\n${model}`;
    setStatus(`Model selected · ${model}`);
    await persistProviderSettings();
    addLine("SYSTEM", `Model changed to ${model} · WORKING and saved locally.`, "#AAB4C5");
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
  if (content.startsWith("/coordinate ")) {
    try {
      const plan = createCoordinatedPlan(content.slice(11));
      const task = createTask(taskStore, plan.goal, plan.steps);
      await saveTasks(taskPath, taskStore);
      addLine("COORDINATED TASK CREATED", `${formatTask(task)}\nWorkspace inspection: ${plan.requiresWorkspace ? "recommended" : "not indicated"}\nResearch: ${plan.requiresResearch ? "included" : "not needed by detected intent"}\nUse /task step ${task.id.slice(0, 8)} <step-id> <status> to track progress.`, "#8FD7A5");
    } catch (error) { addLine("COORDINATOR ERROR", error instanceof Error ? error.message : String(error), "#FF8A8A"); }
    return;
  }
  if (content.startsWith("/agents ")) {
    const goal = content.slice(8).trim();
    if (!goal) { addLine("AGENTS", "Usage: /agents <goal>", "#F2A6C7"); return; }
    setStatus("Independent agents working in parallel…");
    try { await runIndependentAgents(goal); setStatus("Independent agent analysis finished"); }
    catch (error) { addLine("AGENT ERROR", error instanceof Error ? error.message : String(error), "#FF8A8A"); setStatus("Parallel agents unavailable"); }
    return;
  }
  if (content === "/jobs" || content === "/job list") {
    const currentJobs = await loadJobStore(jobPath);
    addLine("BACKGROUND JOBS", currentJobs.jobs.slice().reverse().map((job) => `${job.id.slice(0, 8)} [${job.status}] attempts=${job.attempts} · ${job.goal}${job.error ? `\n  ${job.error}` : ""}`).join("\n\n") || "No background jobs.", "#AAB4C5");
    return;
  }
  if (content.startsWith("/job add ")) {
    try { const job = await withJobStoreTransaction(jobPath, (store) => structuredClone(enqueueJob(store, content.slice(9)))); addLine("JOB QUEUED", `${job.id.slice(0, 8)} · ${job.goal}`, "#8FD7A5"); void runBackgroundQueue(); }
    catch (error) { addLine("JOB ERROR", error instanceof Error ? error.message : String(error), "#FF8A8A"); }
    return;
  }
  if (content.startsWith("/job resume ")) {
    const job = await withJobStoreTransaction(jobPath, (store) => {
      const resumed = resumeJob(store, content.slice(12).trim());
      return resumed ? structuredClone(resumed) : undefined;
    });
    if (!job) { addLine("JOB ERROR", "Job not found or not resumable.", "#FF8A8A"); return; }
    addLine("JOB RESUMED", `${job.id.slice(0, 8)} · queued`, "#8FD7A5"); void runBackgroundQueue(); return;
  }
  if (content === "/tasks") {
    addLine("TASKS", taskStore.tasks.length ? taskStore.tasks.slice().reverse().map(formatTask).join("\n\n") : "No tasks. Create one with /task create <title>.", "#AAB4C5");
    return;
  }
  if (content.startsWith("/task create ")) {
    try {
      const task = createTask(taskStore, content.slice(13));
      await saveTasks(taskPath, taskStore);
      addLine("TASK CREATED", `${formatTask(task)}\nAdd stages with /task plan ${task.id.slice(0, 8)} <step 1 | step 2 | ...>`, "#8FD7A5");
    } catch (error) { addLine("TASK ERROR", error instanceof Error ? error.message : String(error), "#FF8A8A"); }
    return;
  }
  if (content.startsWith("/task plan ")) {
    const match = content.slice(11).match(/^(\S+)\s+(.+)$/);
    if (!match) { addLine("USAGE", "/task plan <task-id> <step 1 | step 2 | ...>", "#F2A6C7"); return; }
    const task = taskStore.tasks.filter((item) => item.id.startsWith(match[1]!));
    if (task.length !== 1 || task[0]!.steps.length) { addLine("TASK ERROR", "Task not found, ID ambiguous, or plan already exists.", "#FF8A8A"); return; }
    try {
      const steps = match[2]!.split("|").map((item) => item.trim()).filter(Boolean);
      if (!steps.length || steps.length > 30) throw new Error("Plan needs 1–30 steps.");
      if (steps.some((title) => title.length > 240)) throw new Error("Each step must be at most 240 characters.");
      const now = new Date().toISOString();
      task[0]!.steps = steps.map((title) => ({ id: crypto.randomUUID(), title, status: "pending", updatedAt: now }));
      task[0]!.updatedAt = now;
      await saveTasks(taskPath, taskStore);
      addLine("TASK PLAN SAVED", formatTask(task[0]!), "#8FD7A5");
    } catch (error) { addLine("TASK ERROR", error instanceof Error ? error.message : String(error), "#FF8A8A"); }
    return;
  }
  if (content.startsWith("/task step ")) {
    const match = content.slice(11).match(/^(\S+)\s+(\S+)\s+(pending|in_progress|completed|blocked|cancelled)(?:\s+(.+))?$/);
    if (!match) { addLine("USAGE", "/task step <task-id> <step-id> <pending|in_progress|completed|blocked|cancelled> [note]", "#F2A6C7"); return; }
    try {
      const step = updateTaskStep(taskStore, match[1]!, match[2]!, match[3]! as TaskStatus, match[4]);
      if (!step) throw new Error("Task or step not found, or ID prefix is ambiguous.");
      await saveTasks(taskPath, taskStore);
      addLine("TASK UPDATED", `${step.status} · ${step.title}${step.note ? `\n${step.note}` : ""}`, "#8FD7A5");
    } catch (error) { addLine("TASK ERROR", error instanceof Error ? error.message : String(error), "#FF8A8A"); }
    return;
  }
  if (content.startsWith("/task check ")) {
    const match = content.slice(12).trim().match(/^(\S+)\s+(\S+)$/);
    if (!match || !TERMINAL_CHECKS.includes(match[2] as (typeof TERMINAL_CHECKS)[number])) {
      addLine("USAGE", `/task check <task-id> <${TERMINAL_CHECKS.join("|")}>`, "#F2A6C7");
      return;
    }
    const matches = taskStore.tasks.filter((item) => item.id.startsWith(match[1]!));
    if (matches.length !== 1) { addLine("TASK ERROR", "Task not found or ID prefix is ambiguous.", "#FF8A8A"); return; }
    const task = matches[0]!;
    const step = [...task.steps].reverse().find((item) => item.status === "blocked" || item.status === "in_progress") ?? [...task.steps].reverse().find((item) => item.status === "completed");
    if (!step) { addLine("TASK CHECK", "This task has no stage to attach evidence to yet.", "#F2A6C7"); return; }
    addLine("TASK CHECK", `Explicitly requested ${match[2]} for ${task.id.slice(0, 8)} · ${step.title}…`, "#AAB4C5");
    try {
      const result = await runTerminalCheck(workspacePath, match[2]!);
      const passed = result.exitCode === 0 && !result.timedOut;
      const summary = sanitizeEvidenceSummary(`${result.command}; exit=${result.exitCode}; timeout=${result.timedOut}; ${result.durationMs}ms; ${result.output.slice(0, 250)}`);
      step.evidence = [...(step.evidence ?? []), { tool: `terminal:${result.check}`, status: passed ? "succeeded" as const : "failed" as const, summary, recordedAt: Date.now() }].slice(-40);
      step.updatedAt = task.updatedAt = new Date().toISOString();
      await saveTasks(taskPath, taskStore);
      addLine(passed ? "TASK EVIDENCE SAVED" : "TASK CHECK FAILED", `${step.title}\n${summary}\n\nEvidence attached to task ${task.id.slice(0, 8)}.`, passed ? "#8FD7A5" : "#FF8A8A");
    } catch (error) {
      addLine("TASK CHECK ERROR", error instanceof Error ? error.message : String(error), "#FF8A8A");
    }
    return;
  }
  if (content.startsWith("/terminal ")) {
    const check = content.slice(10).trim();
    if (!TERMINAL_CHECKS.includes(check as (typeof TERMINAL_CHECKS)[number])) {
      addLine("TERMINAL USAGE", `/terminal <${TERMINAL_CHECKS.join("|")}>`, "#F2A6C7");
      return;
    }
    addLine("TERMINAL CHECK", `Explicitly requested: ${check}. Running fixed command in ${workspacePath}…`, "#AAB4C5");
    try {
      const result = await runTerminalCheck(workspacePath, check);
      const summary = `Command: ${result.command}\nExit code: ${result.exitCode}${result.timedOut ? " (TIMEOUT)" : ""}\nDuration: ${result.durationMs} ms\n\n${result.output || "(no output)"}${result.output.length >= 32_000 ? "\n[output truncated]" : ""}`;
      addLine(result.exitCode === 0 && !result.timedOut ? "TERMINAL PASS" : "TERMINAL FAILED", summary, result.exitCode === 0 && !result.timedOut ? "#8FD7A5" : "#FF8A8A");
    } catch (error) {
      addLine("TERMINAL ERROR", error instanceof Error ? error.message : String(error), "#FF8A8A");
    }
    return;
  }
  if (content.startsWith("/task run ")) {
    const matches = taskStore.tasks.filter((item) => item.id.startsWith(content.slice(10).trim()));
    if (matches.length !== 1) { addLine("TASK ERROR", "Task not found or ID prefix is ambiguous.", "#FF8A8A"); return; }
    const task = matches[0]!;
    if (!client) { addLine("TASK ERROR", "Configure a provider before running a task.", "#FF8A8A"); return; }
    const decision = nextExecutionDecision(task);
    if (decision.kind !== "ready") {
      addLine("TASK EXECUTION", decision.kind === "blocked" ? `${decision.reason}\nStep: ${decision.step.title}` : `Cannot run task: ${decision.kind}.`, "#F2A6C7");
      return;
    }
    const beforeSnapshot = workspaceToolsEnabled ? await captureWorkspaceSnapshot(workspacePath) : [];
    const checkpoint = beginExecutionStep(task, decision.step);
    await saveTasks(taskPath, taskStore);
    const prompt: ChatMessage[] = [{ role: "user", content: `TASK: ${task.title}\nCURRENT STAGE: ${decision.step.title}\n\nWork only on this stage. Use available workspace tools when relevant. Inspect before changing anything. Any file write still requires explicit user approval. Do not claim unverified work is complete. Return concise outcome, files/tools touched, verification evidence, and remaining blockers.` }];
    const controller = new AbortController();
    activeRequest = controller;
    setStatus(`Task ${task.id.slice(0, 8)} · running stage · Esc to stop`);
    addLine("TASK STAGE", `${decision.step.title} · attempt ${checkpoint.attempt}`, "#AAB4C5");
    try {
      const agentResult = workspaceToolsEnabled && client.chatWithTools
        ? await collectWorkspaceAgentWithFallback(prompt, controller.signal)
        : { text: await collectResponse(client, prompt, controller.signal), evidence: [] };
      const result = agentResult.text;
      decision.step.evidence = agentResult.evidence.slice(-40);
      if (workspaceToolsEnabled) {
        const afterSnapshot = await captureWorkspaceSnapshot(workspacePath);
        decision.step.fileChanges = diffWorkspaceSnapshots(beforeSnapshot, afterSnapshot).slice(0, 300);
      }
      finishExecutionStep(task, checkpoint, "blocked", `Stage response requires review: ${result.slice(0, 170) || "empty response"}`);
      await saveTasks(taskPath, taskStore);
      addLine("TASK STAGE RESULT · REVIEW REQUIRED", `${result || "(empty response)"}\n\nStage is saved as BLOCKED for explicit review. If verified, use /task step ${task.id.slice(0, 8)} ${decision.step.id.slice(0, 8)} completed <verification note>. Otherwise use /task resume ${task.id.slice(0, 8)} ${decision.step.id.slice(0, 8)}.`, "#F2A6C7");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try { finishExecutionStep(task, checkpoint, "blocked", `Execution interrupted: ${message}`); await saveTasks(taskPath, taskStore); } catch { /* preserve original execution error */ }
      addLine("TASK EXECUTION ERROR", message, "#FF8A8A");
    } finally {
      activeRequest = undefined;
      setStatus(`Task ${task.id.slice(0, 8)} · stage awaiting review`);
    }
    return;
  }
  if (content.startsWith("/task review ")) {
    const matches = taskStore.tasks.filter((item) => item.id.startsWith(content.slice(12).trim()));
    if (matches.length !== 1) { addLine("TASK ERROR", "Task not found or ID prefix is ambiguous.", "#FF8A8A"); return; }
    const task = matches[0]!;
    const step = [...task.steps].reverse().find((item) => item.status === "blocked");
    if (!step) { addLine("TASK REVIEW", "No blocked stage is available to review.", "#F2A6C7"); return; }
    if (!client) { addLine("TASK ERROR", "Configure a provider before reviewing a task.", "#FF8A8A"); return; }
    const controller = new AbortController();
    activeRequest = controller;
    setStatus(`Task ${task.id.slice(0, 8)} · read-only review`);
    addLine("TASK REVIEW", `Reviewing ${step.title} without workspace tools…`, "#AAB4C5");
    try {
      const review = await collectResponse(client, [{ role: "user", content: buildReviewPrompt({ task, step }) }], controller.signal);
      const verdict = classifyReviewVerdict(review);
      addLine(`REVIEW · ${verdict.toUpperCase()}`, `${review || "Reviewer returned an empty response."}\n\nNo task status was changed. Review is advisory; verify evidence yourself, then use /task step ${task.id.slice(0, 8)} ${step.id.slice(0, 8)} completed <verification note> or /task resume ${task.id.slice(0, 8)} ${step.id.slice(0, 8)}.`, verdict === "pass" ? "#8FD7A5" : "#F2A6C7");
    } catch (error) {
      addLine("REVIEW ERROR", error instanceof Error ? error.message : String(error), "#FF8A8A");
    } finally { activeRequest = undefined; setStatus("Task review finished"); }
    return;
  }
  if (content.startsWith("/task verify ")) {
    const matches = taskStore.tasks.filter((item) => item.id.startsWith(content.slice(12).trim()));
    if (matches.length !== 1) { addLine("TASK ERROR", "Task not found or ID prefix is ambiguous.", "#FF8A8A"); return; }
    const task = matches[0]!;
    const step = [...task.steps].reverse().find((item) => item.status === "blocked" || item.status === "completed");
    if (!step) { addLine("TASK VERIFY", "No executed stage is available to verify.", "#F2A6C7"); return; }
    const requiresCodeChange = /code|implement|fix|refactor|file|test|build|coding|program|bug|fitur/i.test(`${task.title} ${step.title}`);
    const gate = evaluateCompletionGate({ changes: step.fileChanges ?? [], evidence: step.evidence ?? [], requiresCodeChange });
    const changes = step.fileChanges?.length ? step.fileChanges.map((item) => `${item.change}: ${item.path}`).join("\n") : "No file changes observed.";
    addLine(`COMPLETION GATE · ${gate.verdict.toUpperCase()}`, `${gate.reasons.join("\n")}\n\nObserved file changes:\n${changes}\n\nThis gate does not run tests/build and cannot mark a task completed.`, gate.verdict === "eligible_for_review" ? "#8FD7A5" : "#F2A6C7");
    return;
  }
  if (content.startsWith("/task resume ")) {
    const match = content.slice(12).trim().match(/^(\S+)\s+(\S+)$/);
    if (!match) { addLine("USAGE", "/task resume <task-id> <step-id>", "#F2A6C7"); return; }
    const matches = taskStore.tasks.filter((item) => item.id.startsWith(match[1]!));
    if (matches.length !== 1) { addLine("TASK ERROR", "Task not found or ID prefix is ambiguous.", "#FF8A8A"); return; }
    try {
      const step = resumeBlockedStep(matches[0]!, match[2]!);
      await saveTasks(taskPath, taskStore);
      addLine("TASK RESUMED", `${step.title} is pending. Run /task run ${matches[0]!.id.slice(0, 8)} to retry.`, "#8FD7A5");
    } catch (error) { addLine("TASK ERROR", error instanceof Error ? error.message : String(error), "#FF8A8A"); }
    return;
  }
  if (content.startsWith("/task status ")) {
    const task = taskStore.tasks.filter((item) => item.id.startsWith(content.slice(13).trim()));
    addLine("TASK STATUS", task.length === 1 ? formatTask(task[0]!) : "Task not found or ID prefix is ambiguous.", "#AAB4C5");
    return;
  }
  if (content.startsWith("/task cancel ")) {
    const task = updateTask(taskStore, content.slice(13).trim(), "cancelled");
    if (!task) { addLine("TASK ERROR", "Task not found or ID prefix is ambiguous.", "#FF8A8A"); return; }
    await saveTasks(taskPath, taskStore);
    addLine("TASK CANCELLED", formatTask(task), "#AAB4C5");
    return;
  }
  if (content.startsWith("/task delete ")) {
    if (!deleteTask(taskStore, content.slice(13).trim())) { addLine("TASK ERROR", "Task not found or ID prefix is ambiguous.", "#FF8A8A"); return; }
    await saveTasks(taskPath, taskStore);
    addLine("TASK", "Task deleted.", "#AAB4C5");
    return;
  }
  if (content === "/memory" || content === "/memory list") {
    const lines = memoryStore.entries.map((entry) => `${entry.id.slice(0, 8)}  ${entry.text}`);
    addLine("PERSISTENT MEMORY", lines.length ? lines.join("\n") : "No saved memories. Add one with /remember <note>.", "#AAB4C5");
    return;
  }
  if (content.startsWith("/remember ")) {
    try {
      const entry = addMemory(memoryStore, content.slice(10));
      await saveMemory(memoryPath, memoryStore);
      addLine("MEMORY SAVED", `${entry.id.slice(0, 8)}  ${entry.text}\nStored locally. It will be included only when relevant.`, "#AAB4C5");
    } catch (error) { addLine("MEMORY NOT SAVED", error instanceof Error ? error.message : String(error), "#FF8A8A"); }
    return;
  }
  if (content.startsWith("/forget ")) {
    const id = content.slice(8).trim();
    if (!id || !forgetMemory(memoryStore, id)) {
      addLine("MEMORY", "No unique matching memory. Use /memory to see IDs.", "#F2A6C7");
      return;
    }
    await saveMemory(memoryPath, memoryStore);
    addLine("MEMORY", `Forgot memory ${id}.`, "#AAB4C5");
    return;
  }
  if (content === "/memory clear") {
    memoryStore.entries = [];
    await saveMemory(memoryPath, memoryStore);
    addLine("MEMORY", "All persistent memories cleared.", "#AAB4C5");
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
  const automaticContext = await getAutomaticContext(content);
  const activePersona = BUILTIN_PERSONAS.find((item) => item.id === activePersonaId) ?? BUILTIN_PERSONAS[0]!;
  const personaMemories = await loadPersonaMemories(dataDirectory, activePersona.id, content);
  const pending: ChatMessage[] = [
    { role: "system", content: [buildPersonaPrompt(activePersona, personaMemories), buildIntentPolicy(), automaticContext].filter(Boolean).join("\n\n") },
    ...history.messages,
  ];
  setStatus(`Generating with ${model}… · Esc to stop`);
  input.blur();
  const requestController = new AbortController();
  activeRequest = requestController;
  const thinking = startThinkingIndicator(assistantLine);
  let receivedFirstChunk = false;

  try {
    if (workspaceToolsEnabled && client?.chatWithTools) {
      assistantMessage.content = (await collectWorkspaceAgentWithFallback(pending, requestController.signal)).text;
      assistantLine.content = `AKANE\n${assistantMessage.content}`;
    } else {
      await streamWithFallback(pending, requestController.signal, (chunk) => {
        if (!receivedFirstChunk) {
          receivedFirstChunk = true;
          thinking.stop();
        }
        assistantMessage.content += chunk;
        assistantLine.content = `AKANE\n${assistantMessage.content}`;
        transcript.scrollTo({ x: 0, y: transcript.scrollHeight });
      });
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
      // Keep the failed turn in local history so the user's prompt survives a restart.
      assistantMessage.content = `Request failed: ${message}`;
      history.messages.push(assistantMessage);
      await saveHistory();
      assistantLine.content = `ERROR\n${message}`;
      setStatus("Request failed · check provider settings");
    }
  } finally {
    thinking.stop();
    if (activeRequest === requestController) activeRequest = undefined;
    input.focus();
  }
}

function handleInputSubmit(): void {
  const value = input.value;
  // Clear synchronously so the raw-key fallback and InputRenderable.onSubmit
  // cannot submit the same input twice.
  input.value = "";
  if (pendingApproval) {
    const approval = pendingApproval;
    pendingApproval = undefined;
    const approved = value.trim().toLowerCase() === "yes";
    approval.resolve(approved);
    input.placeholder = "Message AkaneChat… (Enter to send)";
    addLine("FILE CHANGE", approved ? `Approved ${approval.path}` : `Rejected ${approval.path}`, approved ? "#8FD7A5" : "#FF8A8A");
    setStatus(approved ? "File change approved" : "File change rejected");
    return;
  }
  if (workspacePicker) {
    selectWorkspace();
    return;
  }
  if (modelPicker) {
    void activatePickedModel();
    return;
  }
  void sendMessage(value);
}

input.onSubmit = handleInputSubmit;
input.focus();
renderer.keyInput.on("keypress", (key) => {
  if (pendingApproval && key.name === "escape") {
    const approval = pendingApproval;
    pendingApproval = undefined;
    approval.resolve(false);
    input.placeholder = "Message AkaneChat… (Enter to send)";
    addLine("FILE CHANGE", `Rejected ${approval.path} · cancelled`, "#FF8A8A");
    setStatus("File change cancelled");
    return;
  }
  if (workspacePicker) {
    // Enter is parsed as "return" by OpenTUI's raw terminal key parser.
    // Handle it here because Android/Termux may not trigger InputRenderable.onSubmit.
    if (key.name === "return" || key.name === "enter" || key.name === "linefeed") {
      selectWorkspace();
      return;
    }
    if (key.name === "escape") {
      workspacePicker.line.content += "\n\nKeeping " + workspacePath;
      workspacePicker = undefined;
      setStatus("Workspace unchanged · " + workspacePath);
      return;
    }
    if (key.name === "up" || key.name === "down") {
      const direction = key.name === "down" ? 1 : -1;
      workspacePicker.selected = (workspacePicker.selected + direction + workspacePicker.entries.length) % workspacePicker.entries.length;
      renderWorkspacePicker();
      return;
    }
  }
  if (modelPicker) {
    if (key.name === "return" || key.name === "enter" || key.name === "linefeed") {
      void activatePickedModel();
      return;
    }
    if (key.name === "escape") {
      modelPicker.line.content += "\n\nSelection cancelled.";
      modelPicker = undefined;
      setStatus(`Model unchanged · ${model}`);
      return;
    }
    if (key.name === "up" || key.name === "down") {
      const direction = key.name === "down" ? 1 : -1;
      let next = modelPicker.selected;
      for (let count = 0; count < modelPicker.choices.length; count++) {
        next = (next + direction + modelPicker.choices.length) % modelPicker.choices.length;
        if (modelPicker.choices[next]!.ok) { modelPicker.selected = next; break; }
      }
      renderModelPicker();
      return;
    }
  }
  // Termux/Android keyboards can emit a raw Return key without causing
  // InputRenderable.onSubmit. Keep a raw-key fallback for normal chat and
  // command input as well as the interactive setup wizard.
  if (key.name === "return" || key.name === "enter" || key.name === "linefeed") {
    handleInputSubmit();
    return;
  }
  if (key.name === "escape" && activeRequest) {
    activeRequest.abort();
    return;
  }
  if (key.ctrl && key.name === "c") renderer.destroy();
});
