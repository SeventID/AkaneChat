# Media generation adapters

Media generation is configured separately from chat providers. AkaneChat never assumes a text model can generate images or videos.

## Environment configuration

| Variable | Purpose |
| --- | --- |
| `AKANECHAT_IMAGE_ENDPOINT` | Full OpenAI-compatible image-generation endpoint |
| `AKANECHAT_IMAGE_API_KEY` | Primary image API key |
| `AKANECHAT_IMAGE_MODEL` | Optional primary image model (defaults to `gpt-image-1`) |
| `AKANECHAT_IMAGE_PROVIDER_ID` | Optional primary adapter ID |
| `AKANECHAT_IMAGE_FALLBACK_ENDPOINT` | Optional backup image endpoint |
| `AKANECHAT_IMAGE_FALLBACK_API_KEY` | Backup image API key |
| `AKANECHAT_IMAGE_FALLBACK_MODEL` | Optional backup image model |
| `AKANECHAT_IMAGE_FALLBACK_PROVIDER_ID` | Optional backup adapter ID |
| `AKANECHAT_VIDEO_ENDPOINT` | Full asynchronous video-generation endpoint |
| `AKANECHAT_VIDEO_API_KEY` | Primary video API key |
| `AKANECHAT_VIDEO_MODEL` | Optional primary video model |
| `AKANECHAT_VIDEO_PROVIDER_ID` | Optional primary adapter ID |
| `AKANECHAT_VIDEO_FALLBACK_ENDPOINT` | Optional backup video endpoint |
| `AKANECHAT_VIDEO_FALLBACK_API_KEY` | Backup video API key |
| `AKANECHAT_VIDEO_FALLBACK_MODEL` | Optional backup video model |
| `AKANECHAT_VIDEO_FALLBACK_PROVIDER_ID` | Optional backup adapter ID |

Keep keys in the process environment or a private environment file; they are never copied into `settings.json`. Remote endpoints must use HTTPS. HTTP is allowed only for localhost development.

Image adapters expect the OpenAI Images API response (`data[0].url` or `data[0].b64_json`). Video adapters expect JSON containing `url`, `output.url`, or `id`. Video responses may include `status_url` or `statusUrl`; when present, AkaneChat polls that same-origin HTTPS URL for up to five minutes by default. The polling interval and maximum wait can be tuned with `AKANECHAT_VIDEO_POLL_INTERVAL_MS` and `AKANECHAT_VIDEO_POLL_MAX_MS`; fallback adapters use `AKANECHAT_VIDEO_FALLBACK_POLL_INTERVAL_MS` and `AKANECHAT_VIDEO_FALLBACK_POLL_MAX_MS`. If the provider returns only an operation ID and no status URL, the accepted operation ID is shown without polling.

Fallback is attempted for network errors, timeouts, HTTP 408/429, and server-side HTTP errors. Authentication and other client-side 4xx errors stop fallback to avoid accidental duplicate paid generation requests. If no adapter is configured, AkaneChat reports the capability unavailable instead of silently using a text-only model.

## TUI routing and capability metadata

Direct generation requests are routed through the configured media adapters. The selected chat model is not used as a substitute when no media adapter is configured. Use `/capabilities` to inspect explicitly registered model metadata, `/capability set provider::model chat,vision` to add verified declarations, and `/capability remove provider::model` to remove one. This registry is descriptive metadata for future model/tool routing; image/video generation currently uses the dedicated endpoint adapters above.
