# AkaneChat

**A multi-provider terminal AI workspace with native streaming and multi-model review.**

AkaneChat is an open-source terminal user interface (TUI) for chatting with AI models directly from your terminal. It is built with [Bun](https://bun.sh/) and [OpenTUI](https://github.com/anomalyco/opentui), and can connect to local gateways such as OmniRoute or any service that exposes a compatible OpenAI Chat Completions API.

> **Version 0.1.5-beta.2 [BETA]:** adds bounded autonomous job execution, persistent job records/checkpoints, independent parallel read-only agents, and verification/replanning stages. The job runner currently lives inside the TUI process: closing AkaneChat stops active work. Interrupted jobs require manual resume, and workspace changes still require the existing approval flow. A detached daemon and automatic checkpoint continuation are not included yet.

## Features

- Full-screen terminal chat interface
- Built-in OpenAI, OpenRouter, Groq, Ollama, Anthropic, and Google Gemini providers
- Any OpenAI-compatible endpoint, including OmniRoute
- Stream model responses in real time across provider adapters
- Route explicit image/video generation requests to separately configured media adapters, with primary/backup providers and bounded same-origin video polling
- Persist explicitly verified model capabilities with `/capability set provider::model chat,vision`; never guess multimodal support from model names
- Add multiple named custom OpenAI-compatible providers with persistent `.env` configuration and automatic model discovery
- Health-check the active model at startup and before switching models; retain the previous model when checks fail
- Configure up to three cross-provider fallback models for transient failures and startup recovery
- Interactive model selector loads up to 60 model IDs without probing them serially; it health-checks only the selected model, retains the previous active model on failure, and supports retry
- Startup workspace directory picker remembers the selected project directory
- OpenAI-compatible models can use workspace agent tools to list, read, and search files, and propose file writes with explicit user approval
- Workspace path safety helpers reject traversal and symlinks
- Optional multi-model council: run 2–4 models in parallel, peer-review answers, then synthesize a final response
- `/agents <goal>` runs up to four independent, parallel, read-only specialist analyses
- `/job add <goal>` queues a bounded autonomous job with execution, independent verification, and feedback-driven replanning
- `/jobs` lists persisted jobs; `/job resume <id-prefix>` manually resumes an interrupted or failed job
- List available models and switch models during a session
- Create, list, reopen, and clear multiple conversations
- Cancel an in-progress response with `Esc`
- Persist conversation history locally
- Handle multiline and final/incomplete Server-Sent Events (SSE) correctly

## Requirements

- [Bun](https://bun.sh/) **1.3.14 or newer**
- A terminal with UTF-8 support
- For Android: ARM64 Termux and an Android-compatible Bun runtime plus the AndroidTUI OpenTUI distribution (see below)

## Installation

Install globally with Bun:

```bash
bun install -g akanechat
```

Then run:

```bash
akanechat
```

### Android / Termux (ARM64)

The TUI dependency is aliased to [`@androidtui/core`](https://github.com/bd-loser/opentui), an Android-compatible OpenTUI distribution that supplies the Android ARM64 native library while retaining the upstream imperative API. It also supplies platform-specific native packages for desktop Linux/macOS/Windows.

Bun's Android support is experimental. For Termux, the ANDROIDTUI maintainers document a patched Bun runtime in [`bd-loser/bun-termux`](https://github.com/bd-loser/bun-termux), and their OpenTUI distribution documents native Termux support. The current release has passed desktop Linux typecheck, build, and automated unit tests. A real-device AkaneChat render test is still required before claiming Android runtime validation. Do not use proot for this path.

```bash
# In Termux ARM64, install the Android-compatible Bun runtime following its upstream instructions.
# Then, inside the AkaneChat checkout:
bun install
bun run typecheck
bun run build
bun run start
```

## Quick start

AkaneChat supports both OpenAI-compatible services and native Anthropic/Gemini APIs. Choose a built-in provider:

```bash
export AKANECHAT_PROVIDER="openai" # openai, openrouter, groq, ollama, anthropic, gemini, custom
export AKANECHAT_MODEL="your-model-id"
export OPENAI_API_KEY="your-api-key"

akanechat
```

Use the matching credential variable for hosted providers:

| Provider | Credential | Default endpoint |
| --- | --- | --- |
| OpenAI | `OPENAI_API_KEY` | `https://api.openai.com/v1` |
| OpenRouter | `OPENROUTER_API_KEY` | `https://openrouter.ai/api/v1` |
| Groq | `GROQ_API_KEY` | `https://api.groq.com/openai/v1` |
| Ollama | Optional | `http://127.0.0.1:11434/v1` |
| Anthropic | `ANTHROPIC_API_KEY` | Native Messages API |
| Google Gemini | `GEMINI_API_KEY` | Native Gemini API |
| Custom / OmniRoute | `AKANECHAT_API_KEY` (if required) | Set `AKANECHAT_BASE_URL` |

You may override any built-in endpoint with `AKANECHAT_BASE_URL`. Existing installations using only `AKANECHAT_BASE_URL`, `AKANECHAT_API_KEY`, and `AKANECHAT_MODEL` remain compatible. Provider credentials are read from the environment and are not persisted in chat history.

Anthropic and Gemini use dedicated native adapters; OpenAI, OpenRouter, Groq, Ollama, and custom gateways use the OpenAI Chat Completions protocol. Provider API keys are read from the matching environment variables and are never saved in `settings.json`. Environment variables override saved preferences.

At startup, AkaneChat checks the configured default model. If it fails, it queries only the configured OpenAI-compatible endpoint at `BASE_URL/models` and tests returned alternatives sequentially (bounded by the endpoint catalogue), selecting and saving the first working model. This discovery never scans unrelated network hosts. Native Anthropic/Gemini adapters use their own model APIs and do not use this OpenAI-compatible fallback scan. The interactive `/model` selector does not health-check the entire catalogue: it loads up to 60 IDs and checks a model only after you select it, keeping startup and browsing responsive on large model catalogues.

You can also connect or change the model from inside the TUI:

- `/status` — show the active provider, model, endpoint, and council selection
- `/providers` — list all supported providers
- `/provider add` — add a named custom OpenAI-compatible provider; enter a unique ID, Base URL, API key, then select a discovered model. Repeat to add more endpoints
- `/provider <id> <model-id>` — select a built-in provider and model
- `/connect <base-url> <model-id>` — connect a custom OpenAI-compatible endpoint
- `/models` — list the first 60 models exposed by the current provider
- `/models <filter>` — filter the provider's model catalog
- `/model` — open the interactive health-checked model selector (arrow keys skip failed models)
- `/model <model-id>` — switch model after a health check
- `/fallback` — list cross-provider fallbacks
- `/fallback add provider::model` — add a fallback (up to three)
- `/fallback remove provider::model` — remove a fallback
- `/workspace` — reopen the workspace directory picker
- `/workspace-tools on|off|status` — enable or disable AI workspace tool calls; setting is saved locally
- `/files` — list readable files in the selected workspace
- `/council <model-a,model-b[,model-c,model-d]>` — enable bounded multi-model review (2–4 models)
- Use `provider::model` for cross-provider agents, e.g. `/council openai::gpt-4o,gemini::gemini-2.5-flash,anthropic::claude-sonnet-4-5`. Each provider reads its own environment API key.
- `/council off` — disable council mode

## Image and video generation

Media generation uses independent endpoints, not the selected chat model. Configure `AKANECHAT_IMAGE_ENDPOINT` + `AKANECHAT_IMAGE_API_KEY` for an OpenAI Images-compatible endpoint, and optionally `AKANECHAT_IMAGE_FALLBACK_ENDPOINT` + `AKANECHAT_IMAGE_FALLBACK_API_KEY` for backup. Video uses `AKANECHAT_VIDEO_ENDPOINT` + `AKANECHAT_VIDEO_API_KEY`, with equivalent `_FALLBACK_` variables. Optional `*_MODEL` and `*_PROVIDER_ID` variables select model and display ID. Keep these credentials in the process environment or a private env file; they are not stored in settings. See [`docs/MEDIA_ADAPTERS.md`](docs/MEDIA_ADAPTERS.md) for response formats, polling, security constraints, and all variables.

Type a direct request such as “buat gambar kucing astronot” or “buat video pendek suasana pantai”. AkaneChat routes only recognized generation requests. For video endpoints that return `status_url`/`statusUrl`, it polls the same HTTPS origin for up to five minutes by default. Provider-specific API formats may require an adapter; an OpenAI-compatible chat endpoint alone does not imply image/video support.

## Commands

| Command | Description |
| --- | --- |
| `/status` | Show active provider/model/council configuration |
| `/capabilities` | List explicitly registered model capabilities |
| `/capability set provider::model chat,vision` | Save verified capability metadata for a model |
| `/capability remove provider::model` | Remove a model capability declaration |
| `/providers` | List built-in and saved custom providers |
| `/provider <id> [model-id]` | Select and save built-in or custom provider/model |
| `/connect <base-url> <model-id>` | Connect to an API endpoint for this session |
| `/models [filter]` | List/filter available models (60 displayed at a time) |
| `/provider add` | Add a custom OpenAI-compatible provider interactively |
| `/model` | Open interactive checked model selector |
| `/model <model-id>` | Switch the active model after a health check |
| `/fallback [add/remove provider::model]` | Manage up to three cross-provider fallbacks |
| `/workspace` | Reopen the startup workspace picker |
| `/workspace-tools on|off|status` | Toggle AI workspace tools; OFF sends no tool definitions to the model |
| `/files` | List readable files in the selected workspace |
| `/tasks` and `/task ...` | Manage staged tasks, review, resume, and verify evidence |
| `/terminal <typecheck|test|build|diff>` | Run one fixed project check explicitly; arbitrary shell commands are rejected |
| `/task check <task-id> <check>` | Run a fixed check and attach its result to the latest task stage |
| `/council <model-a,model-b,...>` | Enable multi-model review (2–4 models; cross-provider via `provider::model`) |
| `/council off` | Disable multi-model review |
| `/agents <goal>` | Run up to four parallel read-only specialist agents |
| `/jobs` or `/job list` | List persisted background jobs |
| `/job add <goal>` | Queue a bounded autonomous job |
| `/job resume <id-prefix>` | Manually resume a failed/interrupted job |
| `/new` | Create a new conversation |
| `/chats` | List saved conversations and short IDs |
| `/switch <id-prefix>` | Reopen a saved conversation |
| `/clear` | Clear only the current conversation |
| `/help` | Show command help |
| `/quit` | Exit AkaneChat |
| `Esc` | Cancel the current response |

## Data and security

- Built-in provider API keys are read from environment variables. Custom providers are stored as individually named `AKANECHAT_CUSTOM_<ID>_*` variables in the project `.env` file. The file is written with mode `0600`; credentials are not printed in the UI or added to conversation history. Keep `.env` out of version control and backups that are not encrypted.
- Provider preferences, fallback model IDs, and the optional council model selection are stored at `~/.local/share/akanechat/settings.json` with mode `0600`; the directory uses mode `0700`. API keys are never included.
- Council mode runs at most four selected models concurrently, then one peer-review pass and one synthesis call. Each generation is capped at 2,048 output tokens. It is opt-in and can be cancelled with `Esc`; usage/cost depends on the selected provider and models.
- Conversation history is stored locally at `~/.local/share/akanechat/history.json`.
- Background job metadata/checkpoints are stored at `~/.local/share/akanechat/jobs.json` with restrictive storage permissions. Jobs are processed sequentially (one at a time) to avoid concurrent writes to a shared workspace. The runner is tied to the TUI process; it is not a system daemon and does not survive app exit. On restart, running jobs are marked interrupted and must be resumed manually.
- Autonomous jobs have a bounded retry/verification loop (up to three execution attempts by default and a 30-minute time budget). A verifier must explicitly return `pass`; malformed or uncertain verification never counts as success. Workspace writes remain subject to explicit approval.
- The storage layer writes atomically and uses restrictive permissions (directory `0700`, file `0600`).
- Conversation data remains on the local machine; requests are sent to the API endpoint you configure.
- Never commit real API keys, access tokens, or other secrets.

## Development

```bash
git clone https://github.com/SeventID/AkaneChat.git
cd AkaneChat
bun install
bun run dev
```

Useful scripts:

```bash
bun run typecheck
bun test
bun run build
```

## Roadmap

The following are project directions, not promises that these features are already available:

- Saved named cross-provider council profiles and per-agent model presets
- Android Termux-native runtime validation and compatibility improvements
- Configurable council round, token, and budget limits
- Extensible tools and plugin integrations
- Image and document input where supported by providers

## Contributing

Bug reports, feature requests, and pull requests are welcome. Please include reproduction steps, relevant logs with secrets removed, and your environment details when reporting an issue.

- Issues: https://github.com/SeventID/AkaneChat/issues
- Source: https://github.com/SeventID/AkaneChat

## License

AkaneChat is licensed under the **Apache License 2.0**. See [LICENSE](./LICENSE).

## Workspace agent tools

When workspace tools are ON (the default) and the active provider is OpenAI-compatible, AkaneChat can inspect the selected workspace with `list_files`, `read_file`, and `search_files`. It can propose `write_file` operations, but every create/replace waits for an explicit `yes` in the TUI; `no` or `Esc` rejects the change. Paths are restricted to the selected workspace, symlinks and traversal are rejected, sensitive paths such as `.env*`, `.git`, `.ssh`, credential files, and private keys are blocked, and text files are capped at 256 KB. Tool calling is not yet enabled for the native Anthropic and Gemini adapters. Workspace tool execution is bounded to 32 rounds and 64 tool calls per user request, with progress notices every eight rounds. If a provider error explicitly names an unsupported workspace tool (for example `list_files`), AkaneChat disables only that tool for that provider/model in the current session and retries with the remaining tools. Tool definitions stay in the app and other models are checked independently. If the provider rejects tool calling entirely, AkaneChat falls back to ordinary chat for that model. `/workspace-tools off` remains an optional manual override, and the preference is persisted in local settings. `/files` remains available as a manual command when AI workspace tools are OFF.


## Task execution and terminal checks

Task execution is checkpointed in `~/.local/share/akanechat/tasks.json`. `/task run <id>` runs one stage and then blocks for review; it does not silently mark model output as completed. Use `/task review <id>` for an advisory read-only review, `/task verify <id>` for the evidence gate, and manually confirm a stage with `/task step <task-id> <step-id> completed <verification note>` only after checking the result. Interrupted in-progress stages are recovered as blocked after restart and are never auto-replayed.

The terminal executor is deliberately not a general shell. `/terminal typecheck`, `/terminal test`, `/terminal build`, and `/terminal diff` map to fixed project commands, with a 120-second timeout and bounded output. These commands run only after the user explicitly enters them. `/task check <id> <check>` attaches the result to the latest relevant task stage. This is a restricted verification facility, not autonomous unrestricted command execution.
