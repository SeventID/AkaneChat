# AkaneChat

**A full-screen terminal AI chat client for OpenAI-compatible APIs.**

AkaneChat is an open-source terminal user interface (TUI) for chatting with AI models directly from your terminal. It is built with [Bun](https://bun.sh/) and [OpenTUI](https://github.com/anomalyco/opentui), and can connect to local gateways such as OmniRoute or any service that exposes a compatible OpenAI Chat Completions API.

> **Current release: 0.1.2** — early development. The core chat workflow is available; multi-provider native adapters and multi-agent orchestration are planned, not yet implemented.

## Features

- Full-screen terminal chat interface
- Connect to OpenAI-compatible API endpoints
- Stream model responses in real time
- List available models and switch models during a session
- Create, list, reopen, and clear multiple conversations
- Cancel an in-progress response with `Esc`
- Persist conversation history locally
- Handle multiline and final/incomplete Server-Sent Events (SSE) correctly

## Requirements

- [Bun](https://bun.sh/) **1.3.14 or newer**
- A terminal with UTF-8 support

## Installation

Install globally with Bun:

```bash
bun install -g akanechat
```

Then run:

```bash
akanechat
```

## Quick start

AkaneChat uses an OpenAI-compatible endpoint. Set the connection details in your environment:

```bash
export AKANECHAT_BASE_URL="https://api.example.com/v1"
export AKANECHAT_API_KEY="your-api-key"
export AKANECHAT_MODEL="your-model-id"

akanechat
```

For a local gateway, use its local URL and the authentication settings required by that gateway. For example, an OmniRoute-compatible endpoint can be configured with its own base URL, key, and model ID.

You can also connect or change the model from inside the TUI:

- `/connect <base-url> <model-id>` — connect for the current session
- `/models` — list models exposed by the current provider
- `/model <model-id>` — switch model

## Commands

| Command | Description |
| --- | --- |
| `/connect <base-url> <model-id>` | Connect to an API endpoint for this session |
| `/models` | List available models |
| `/model <model-id>` | Switch the active model |
| `/new` | Create a new conversation |
| `/chats` | List saved conversations and short IDs |
| `/switch <id-prefix>` | Reopen a saved conversation |
| `/clear` | Clear only the current conversation |
| `/help` | Show command help |
| `/quit` | Exit AkaneChat |
| `Esc` | Cancel the current response |

## Data and security

- API keys are read from `AKANECHAT_API_KEY`; they are not written to conversation history.
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

- Native adapters for additional AI providers
- More flexible provider and model management
- Optional parallel multi-model / multi-agent workflows
- Extensible tools and plugin integrations
- Image and document input where supported by providers

## Contributing

Bug reports, feature requests, and pull requests are welcome. Please include reproduction steps, relevant logs with secrets removed, and your environment details when reporting an issue.

- Issues: https://github.com/SeventID/AkaneChat/issues
- Source: https://github.com/SeventID/AkaneChat

## License

AkaneChat is licensed under the **Apache License 2.0**. See [LICENSE](./LICENSE).
