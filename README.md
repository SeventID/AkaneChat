# AkaneChat

**A full-screen terminal AI chat client for OpenAI-compatible providers.**

AkaneChat is an open-source TUI project built with Bun and OpenTUI. It is designed to work with local gateways such as OmniRoute, as well as other compatible API providers.

> Early development: the current `0.1.0` scaffold is a UI foundation, not a feature-complete chat client.

## Goals

- Full-screen terminal interface with chat history and model selection
- OpenAI-compatible provider adapters
- Streaming responses
- Local conversation persistence
- Image and document attachments where supported
- Optional image/video generation when the selected provider supports it
- Extensible plugin system

## Requirements

- Bun `>=1.3.14`
- A terminal with UTF-8 support

## Configure a provider

AkaneChat connects to any provider that implements the OpenAI-compatible Chat Completions API.

Set these environment variables before launching:

```bash
export AKANECHAT_BASE_URL="http://127.0.0.1:20128/v1"
export AKANECHAT_API_KEY="" # optional for local providers
export AKANECHAT_MODEL="your-model-id"
bun run start
```

You can also connect or switch models from inside the TUI:

- `/connect <base-url> <model-id>` — connect for the current session
- `/models` — list models exposed by the provider
- `/model <model-id>` — switch model
- `/new` — create a new conversation without deleting older chats
- `/chats` — list saved conversations and their short IDs
- `/switch <id-prefix>` — reopen a saved conversation
- `/clear` — clear only the current conversation
- `Esc` — stop the current response and keep any partial answer
- `/help` — show commands
- `/quit` — exit

The API key is read only from `AKANECHAT_API_KEY`; it is never written to conversation history. Conversations are stored locally at `~/.local/share/akanechat/history.json`. The store migrates the previous single-history format automatically, writes atomically, and uses restrictive file permissions (directory `0700`, file `0600`). Conversation content is local; provider API keys are not stored in this file.

## Development

```bash
git clone https://github.com/SeventID/AkaneChat.git
cd AkaneChat
bun install
bun run dev
```

## Configuration

Copy `.env.example` to `.env` and configure an OpenAI-compatible endpoint. Never commit real API keys or tokens.

## License

Apache-2.0. See [LICENSE](./LICENSE).
