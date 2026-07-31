---
title: Deployment
description: Deploy Seepient Agent Server with Docker, Cloud Run, or bare metal. Error codes, provider configuration, and production notes.
---

# Deployment

Seepient Agent Server is a stateless Node.js process that can be deployed as a Docker container, on Cloud Run, or directly on any Node.js host.

## Docker

### Build and run

```bash
docker run -d -p 7337:7337 \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -v ~/.seepient:/root/.seepient \
  seepient-server
```

### With multiple providers

```bash
docker run -d -p 7337:7337 \
  -e OPENAI_API_KEY=sk-... \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e GLM_API_KEY=... \
  -e LLM_PROVIDER=anthropic \
  -v ~/.seepient:/root/.seepient \
  seepient-server
```

### With custom session directory

```bash
docker run -d -p 7337:7337 \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e SEEPIENT_SESSION_DIR=/data/sessions \
  -v session-data:/data/sessions \
  seepient-server
```

### Docker Compose

```yaml
services:
  seepient:
    image: seepient-server
    build: .
    ports:
      - "7337:7337"
    environment:
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - OPENAI_API_KEY=${OPENAI_API_KEY}
      - LLM_PROVIDER=anthropic
      - SEEPIENT_SESSION_TTL=86400
    volumes:
      - ./data/.seepient:/root/.seepient
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:7337/v1/health"]
      interval: 30s
      timeout: 5s
      retries: 3
```

## Google Cloud Run

```bash
gcloud run deploy seepient \
  --image seepient-server \
  --port 7337 \
  --min-instances 1 \
  --max-instances 10 \
  --timeout 3600 \
  --set-env-vars "ANTHROPIC_API_KEY=sk-ant-..."
```

### Cloud Run WebSocket considerations

::: warning Cloud Run has WebSocket limitations

- **Heartbeat**: Send a `ping` message every 30 seconds to keep the connection alive. Cloud Run may close idle connections.
- **Request timeout**: Cloud Run has a maximum request duration of 60 minutes. Long-running conversations should use the reconnection protocol.
- **Session externalization**: File-based sessions do not persist across Cloud Run instances. Use the `SEEPIENT_SESSION_DIR` environment variable to point to a mounted volume, or externalize session storage with Redis.

:::

### Cloud Run with secrets

```bash
gcloud run deploy seepient \
  --image seepient-server \
  --port 7337 \
  --min-instances 1 \
  --max-instances 10 \
  --timeout 3600 \
  --set-secrets "ANTHROPIC_API_KEY=anthropic-key:latest"
```

## Bare metal / Node.js

### Direct Node.js

```bash
# Install
npm install -g seepient

# Run with environment
ANTHROPIC_API_KEY=sk-ant-... seepient server
```

### Programmatic

```typescript
import { startServer } from "seepient/server";

const server = await startServer({
  port: 7337,
  host: "0.0.0.0",
  cors: true,
  sessionTTL: 86400,
});
```

### Process manager (PM2)

```bash
npm install -g pm2 seepient

# Start with PM2
ANTHROPIC_API_KEY=sk-ant-... pm2 start "seepient server" --name seepient

# Save for auto-restart
pm2 save
pm2 startup
```

## Provider environment variables

| Variable | Description | Required |
|---|---|---|
| `OPENAI_API_KEY` | OpenAI API key | For OpenAI provider |
| `OPENAI_MODEL` | Default OpenAI model (default: `gpt-5.4`) | No |
| `ANTHROPIC_API_KEY` | Anthropic API key | For Anthropic provider |
| `ANTHROPIC_MODEL` | Default Anthropic model (default: `claude-sonnet-4-6-20260320`) | No |
| `GLM_API_KEY` | GLM API key | For GLM provider |
| `GLM_MODEL` | Default GLM model (default: `glm-5.1`) | No |
| `OPENAI_COMPAT_API_KEY` | API key for OpenAI-compatible provider | For compatible provider |
| `OPENAI_COMPAT_BASE_URL` | Base URL for OpenAI-compatible provider | For compatible provider |
| `LLM_MODEL` | Default model for OpenAI-compatible provider (default: `gpt-5.4`) | No |
| `LLM_PROVIDER` | Default provider (auto-detected if not set) | No |
| `SEEPIENT_SKILLS_PATH` | Colon-separated paths to skill directories | No |

::: tip Provider auto-detection
If `LLM_PROVIDER` is not set, the server uses the first configured provider. If `OPENAI_API_KEY` is set, OpenAI becomes the default. Otherwise, the first provider with a configured API key is used.
:::

## Error codes

### REST error codes

| Code | HTTP Status | Retryable | Description |
|---|---|---|---|
| `UNAUTHORIZED` | 401 | No | Invalid or missing API key |
| `FORBIDDEN` | 403 | No | API key lacks required scope |
| `BAD_REQUEST` | 400 | No | Invalid request body or missing fields |
| `NOT_FOUND` | 404 | No | Endpoint or session not found |
| `PROVIDER_ERROR` | 502 | Yes | LLM provider returned an error |
| `GENERATION_ERROR` | 500 | Yes | Text generation failed |
| `INTERNAL_ERROR` | 500 | No | Unexpected server error |

### WebSocket error codes

| Code | Retryable | Description |
|---|---|---|
| `UNAUTHORIZED` | No | Authentication failed on upgrade |
| `INVALID_MESSAGE` | No | Malformed JSON |
| `UNKNOWN_MESSAGE_TYPE` | No | Unrecognized message type |
| `PROVIDER_ERROR` | Yes | LLM provider error |
| `STREAM_ERROR` | No | Internal streaming failure |
| `SESSION_NOT_FOUND` | No | Session expired or missing |
| `ABORTED` | No | Request cancelled by client |

### Retry strategy

For retryable errors (`PROVIDER_ERROR`, `GENERATION_ERROR`):

```
Attempt 1 ──► wait 1s ──► Attempt 2 ──► wait 2s ──► Attempt 3 ──► fail
```

- Maximum 3 retries
- Exponential backoff: 1s, 2s, 4s
- Do not retry non-retryable errors

## Graceful shutdown

The server handles `SIGINT` and `SIGTERM` with a 5-second drain timeout:

1. Stops accepting new connections
2. Closes all active WebSocket connections with code `1001`
3. Stops the session cleanup timer
4. Waits up to 5 seconds for in-flight requests to complete
5. Force exits if drain exceeds the timeout

## Health monitoring

Use the `/v1/health` endpoint for load balancer health checks:

```bash
curl -f http://localhost:7337/v1/health || exit 1
```

Response:

```json
{
  "status": "ok",
  "version": "0.1.1",
  "uptime": 3600
}
```

## Production checklist

- [ ] Set at least one provider API key via environment variable
- [ ] Generate API keys with minimal required scopes
- [ ] Verify `~/.seepient/server-keys.json` permissions are `0600`
- [ ] Mount a persistent volume for `./.seepient/sessions/` if using sessions
- [ ] Configure health check against `/v1/health`
- [ ] Set `SEEPIENT_SESSION_TTL` appropriate for your use case
- [ ] Enable WebSocket heartbeat (ping/pong every 30s) for Cloud Run deployments
- [ ] Configure reverse proxy (nginx, Cloud Load Balancer) with WebSocket upgrade support
- [ ] Set up log aggregation for `[server]` and `[ws]` log prefixes
