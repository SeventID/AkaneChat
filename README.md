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
