---
title: Server Overview
description: Seepient Agent Server architecture, startup options, and quick-start guide.
---

# Server Overview

Seepient Agent can be deployed as a standalone container exposing an HTTP REST API and a WebSocket endpoint on port **7337**. The server delegates directly to the core agent loop (`runAgentLoop`) with authentication, session management, and real-time streaming -- ready for production workloads behind a load balancer or directly on bare metal.

## Architecture

```
                 ┌─────────────────────────────────────┐
                 │           Seepient Agent Server               │
   REST ────────│  /v1/health   /v1/chat   /v1/models  │
   (HTTP)       │  /v1/skills   /v1/sessions/:id       │
                 │                                       │
   WebSocket ───│  /ws   (auth via ?token=)             │
                 │                                       │
                 │  ┌──────────┐  ┌───────────────────┐ │
                 │  │ Auth     │  │ Session Manager   │ │
                 │  │ (API key)│  │ (file-based TTL)  │ │
                 │  └──────────┘  └───────────────────┘ │
                 │           ┌─────────────┐            │
                 │           │ Core Engine │            │
                 │           └─────────────┘            │
                 └─────────────────────────────────────┘
```

The server delegates all LLM interaction directly to the core `runAgentLoop`, bypassing the SDK layer. Every request flows through the same core agent loop, so tool execution, hooks, abort handling, and usage tracking behave identically to direct SDK usage.

### Key characteristics

| Feature | Detail |
|---|---|
| **Default port** | `7337` (configurable via `SEEPIENT_PORT` or `PORT` env) |
| **CORS** | Enabled by default; mirrors request `Origin` |
| **Graceful shutdown** | SIGINT / SIGTERM with 5-second drain timeout |
| **Session storage** | File-based in `./.seepient/sessions/` |
| **Auth** | API keys with scoped permissions |

## Startup commands

::: code-group

```bash [Docker]
docker run -d -p 7337:7337 \
  -e ANTHROPIC_API_KEY=sk-... \
  -v ~/.seepient:/root/.seepient \
  seepient-server
```

```bash [Cloud Run]
gcloud run deploy seepient \
  --image seepient-server \
  --port 7337 \
  --set-env-vars "ANTHROPIC_API_KEY=sk-..."
```

```bash [npx]
npx seepient server
```

```bash [npm script]
npm install -g seepient
seepient server
```

```bash [Node.js]
import { startServer } from "seepient/server";

await startServer({ port: 7337 });
```

:::

## Quick start

1. **Install and run**

   ```bash
   npx seepient server
   ```

2. **Generate an API key**

   ```bash
   seepient server --generate-api-key
   ```

   This prints a key like `sk_seepient_a1b2c3...` and stores it in `~/.seepient/server-keys.json`.

3. **Send a chat request**

   ```bash
   curl -X POST http://localhost:7337/v1/chat \
     -H "Content-Type: application/json" \
     -H "X-Seepient-API-Key: sk_seepient_..." \
     -d '{"message": "Hello, world!"}'
   ```

4. **Open a WebSocket for streaming**

   ```javascript
   const ws = new WebSocket("ws://localhost:7337/ws?token=sk_seepient_...");
   ws.onmessage = (e) => console.log(JSON.parse(e.data));
   ws.send(JSON.stringify({
     type: "chat",
     id: "1",
     message: "Explain quantum computing"
   }));
   ```

## Environment variables

| Variable | Description | Default |
|---|---|---|
| `SEEPIENT_PORT` / `PORT` | Server listen port | `7337` |
| `OPENAI_API_KEY` | OpenAI provider key | -- |
| `ANTHROPIC_API_KEY` | Anthropic provider key | -- |
| `GLM_API_KEY` | GLM provider key | -- |
| `OPENAI_COMPAT_API_KEY` | API key for OpenAI-compatible provider | -- |
| `OPENAI_COMPAT_BASE_URL` | Base URL for OpenAI-compatible provider | -- |
| `LLM_MODEL` | Default model for OpenAI-compatible provider | `gpt-5.4` |
| `LLM_PROVIDER` | Default provider (`openai`, `anthropic`, `glm`, `openai-compatible`) | Auto-detected |
| `OPENAI_MODEL` | Default OpenAI model | `gpt-5.4` |
| `ANTHROPIC_MODEL` | Default Anthropic model | `claude-sonnet-4-6-20260320` |
| `GLM_MODEL` | Default GLM model | `glm-5.1` |
| `SEEPIENT_SESSION_DIR` | Directory for session files | `./.seepient/sessions` |
| `SEEPIENT_SESSION_TTL` | Session TTL in seconds | `86400` (24 hours) |
| `SEEPIENT_SKILLS_PATH` | Colon-separated paths to skill directories | -- |

## Next steps

- [REST API reference](/server/rest-api) -- endpoint-by-endpoint documentation
- [WebSocket API reference](/server/websocket-api) -- real-time streaming protocol
- [Authentication](/server/authentication) -- API key management and scopes
- [Sessions](/server/sessions) -- session lifecycle and reconnection
- [Deployment](/server/deployment) -- Docker, Cloud Run, and production notes
