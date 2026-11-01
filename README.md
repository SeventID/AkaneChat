# AkaneChat

**A multi-provider terminal AI workspace with native streaming and multi-model review.**

AkaneChat is an open-source terminal user interface (TUI) for chatting with AI models directly from your terminal. It is built with [Bun](https://bun.sh/) and [OpenTUI](https://github.com/anomalyco/opentui), and can connect to local gateways such as OmniRoute or any service that exposes a compatible OpenAI Chat Completions API.

> **Development build:** the provider registry, native Anthropic/Gemini adapters, and bounded multi-model review workflow are implemented on `main`. A stable `0.2.0` release will follow broader integration and Android Termux validation.

## Features

- Full-screen terminal chat interface
- Built-in OpenAI, OpenRouter, Groq, Ollama, Anthropic, and Google Gemini providers
- Any OpenAI-compatible endpoint, including OmniRoute
- Stream model responses in real time across provider adapters
- Add custom OpenAI-compatible providers interactively with Base URL, visible API-key entry, and automatic model discovery
- Health-check the active model at startup and before switching models; retain the previous model when checks fail
- Configure up to three cross-provider fallback models for transient failures and startup recovery
- Interactive model selector marks working/failed models and arrow navigation skips failed models
- Startup workspace directory picker remembers the selected project directory
- OpenAI-compatible models can use workspace agent tools to list, read, and search files, and propose file writes with explicit user approval
- Workspace path safety helpers reject traversal and symlinks
- Optional multi-model council: run 2–4 models in parallel, peer-review answers, then synthesize a final response
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

Bun's Android support is experimental. For Termux, the ANDROIDTUI maintainers document a patched Bun runtime in [`bd-loser/bun-termux`](https://github.com/bd-loser/bun-termux), and their OpenTUI distribution documents native Termux support. This project has passed desktop Linux build/type tests, but a real-device AkaneChat render test is still required before claiming Android runtime validation. Do not use proot for this path.

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

You can also connect or change the model from inside the TUI:

- `/status` — show the active provider, model, endpoint, and council selection
- `/providers` — list all supported providers
- `/provider add` — add a custom OpenAI-compatible provider interactively; Base URL and visible API-key input are requested, then `/models` is discovered
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
- `/files` — list readable files in the selected workspace
- `/council <model-a,model-b[,model-c,model-d]>` — enable bounded multi-model review (2–4 models)
- Use `provider::model` for cross-provider agents, e.g. `/council openai::gpt-4o,gemini::gemini-2.5-flash,anthropic::claude-sonnet-4-5`. Each provider reads its own environment API key.
- `/council off` — disable council mode

## Commands

| Command | Description |
| --- | --- |
| `/status` | Show active provider/model/council configuration |
| `/providers` | List built-in providers |
| `/provider <id> [model-id]` | Select and save provider/model |
| `/connect <base-url> <model-id>` | Connect to an API endpoint for this session |
| `/models [filter]` | List/filter available models (60 displayed at a time) |
| `/provider add` | Add a custom OpenAI-compatible provider interactively |
| `/model` | Open interactive checked model selector |
| `/model <model-id>` | Switch the active model after a health check |
| `/fallback [add/remove provider::model]` | Manage up to three cross-provider fallbacks |
| `/workspace` | Reopen the startup workspace picker |
| `/files` | List readable files in the selected workspace |
| `/council <model-a,model-b,...>` | Enable multi-model review (2–4 models; cross-provider via `provider::model`) |
| `/council off` | Disable multi-model review |
| `/new` | Create a new conversation |
| `/chats` | List saved conversations and short IDs |
| `/switch <id-prefix>` | Reopen a saved conversation |
| `/clear` | Clear only the current conversation |
| `/help` | Show command help |
| `/quit` | Exit AkaneChat |
| `Esc` | Cancel the current response |

## Data and security

- Built-in provider API keys are read from environment variables. A custom provider API key entered through /provider add is visible while typing and held in memory only for the current process; it is not persisted, logged, or added to conversation history.
- Provider preferences, fallback model IDs, and the optional council model selection are stored at `~/.local/share/akanechat/settings.json` with mode `0600`; the directory uses mode `0700`. API keys are never included.
- Council mode runs at most four selected models concurrently, then one peer-review pass and one synthesis call. Each generation is capped at 2,048 output tokens. It is opt-in and can be cancelled with `Esc`; usage/cost depends on the selected provider and models.
- Conversation history is stored locally at `~/.local/share/akanechat/history.json`.
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

When the active provider is OpenAI-compatible and supports Chat Completions tool calling, AkaneChat can inspect the selected workspace with `list_files`, `read_file`, and `search_files`. It can propose `write_file` operations, but every create/replace waits for an explicit `yes` in the TUI; `no` or `Esc` rejects the change. Paths are restricted to the selected workspace, symlinks and traversal are rejected, sensitive paths such as `.env*`, `.git`, `.ssh`, credential files, and private keys are blocked, and text files are capped at 256 KB. Tool calling is not yet enabled for the native Anthropic and Gemini adapters. Workspace tool rounds are capped at eight per user message.\n
