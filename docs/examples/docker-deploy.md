---
title: Docker Deployment
description: Deploy Seepient Agent as a Docker container with complete configuration and Docker Compose example.
---

# Docker Deployment

Run Seepient Agent as a containerized backend service. This example covers building the image, running it locally, persisting sessions, and using Docker Compose.

## Prerequisites

- Docker installed and running
- At least one LLM provider API key

## Dockerfile

Seepient Agent includes a Dockerfile in the repository. Build it from source:

```bash
git clone https://github.com/hashangit/seepient.git
cd seepient
docker build -t seepient-server .
```

## Build and Run

### Using the `seepient server` command

After building, start the server inside the container using `seepient server`:

```bash
docker run -d \
  --name seepient \
  -p 7337:7337 \
  -e OPENAI_API_KEY=sk-... \
  seepient-server \
  seepient server
```

Generate an API key for authenticated access:

```bash
docker exec -it seepient seepient server --generate-api-key
```

This prints a key like `sk_seepient_a1b2c3...` and stores it in `~/.seepient/server-keys.json`.

### Using the `--docker` CLI flag

Run the Seepient Agent CLI inside Docker with the `--docker` flag for container-aware defaults:

```bash
docker run -it --rm \
  -e OPENAI_API_KEY=sk-... \
  seepient-server \
  seepient --docker "List files in the current directory"
```

### Basic Run

Start the server on port 7337:

```bash
docker run -d \
  --name seepient \
  -p 7337:7337 \
  -e OPENAI_API_KEY=sk-... \
  seepient-server
```

Verify it is running:

```bash
curl http://localhost:7337/v1/health
# {"status":"ok","version":"0.1.1","uptime":5}
```

### With Environment File

Create a `.env` file with your configuration:

```bash
# .env
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
LLM_PROVIDER=openai
OPENAI_MODEL=gpt-5.4
TAVILY_API_KEY=tvly-...
```

Run with the environment file:

```bash
docker run -d \
  --name seepient \
  -p 7337:7337 \
  --env-file .env \
  seepient-server
```

## Environment Variable Configuration

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | At least one | OpenAI API key |
| `ANTHROPIC_API_KEY` | At least one | Anthropic API key |
| `GLM_API_KEY` | At least one | GLM API key |
| `OPENAI_COMPAT_API_KEY` | At least one | API key for OpenAI-compatible provider (e.g. DeepSeek, Ollama) |
| `OPENAI_COMPAT_BASE_URL` | For compat provider | Base URL for OpenAI-compatible provider |
| `LLM_PROVIDER` | No | Default provider (default: auto-detected) |
| `OPENAI_MODEL` | No | Default OpenAI model (default: `gpt-5.4`) |
| `ANTHROPIC_MODEL` | No | Default Anthropic model (default: `claude-sonnet-4-6-20260320`) |
| `GLM_MODEL` | No | Default GLM model (default: `glm-5.1`) |
| `LLM_MODEL` | No | Default model for OpenAI-compatible provider (default: `gpt-5.4`) |
| `SEEPIENT_PORT` | No | Server port (default: `7337`) |
| `SEEPIENT_SKILLS_PATH` | No | Colon-separated paths to custom skill directories |
| `TAVILY_API_KEY` | No | Required for `web_search` tool |
| `SMTP_HOST` | No | SMTP server for `send_email` |
| `SMTP_PORT` | No | SMTP port (default: `587`) |
| `SMTP_USER` | No | SMTP username |
| `SMTP_PASS` | No | SMTP password |
| `SEEPIENT_SESSION_DIR` | No | Session storage directory (default: `./.seepient/sessions`) |
| `SEEPIENT_SESSION_TTL` | No | Session TTL in seconds (default: `86400`) |
| `SEEPIENT_SHELL_APPROVE` | No | Shell command approval in containers: `auto` (approve all), `deny` (block all). Default in non-interactive: `deny` |

## Volume Mounting for Sessions

Persist sessions to the host filesystem so they survive container restarts:

```bash
docker run -d \
  --name seepient \
  -p 7337:7337 \
  --env-file .env \
  -v seepient-sessions:/data/sessions \
  seepient-server
```

Or bind-mount a specific directory:

```bash
docker run -d \
  --name seepient \
  -p 7337:7337 \
  --env-file .env \
  -v $(pwd)/sessions:/data/sessions \
  seepient-server
```

## Docker Compose

Create a `docker-compose.yml` for a complete deployment with Redis for session storage:

```yaml
services:
  seepient:
    image: seepient-server
    build: .
    ports:
      - "7337:7337"
    environment:
      - OPENAI_API_KEY=${OPENAI_API_KEY}
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - LLM_PROVIDER=openai
      - OPENAI_MODEL=gpt-5.4
      - TAVILY_API_KEY=${TAVILY_API_KEY}
      - SEEPIENT_SKILLS_PATH=/mnt/skills
      - SEEPIENT_SESSION_DIR=/data/sessions
      - SEEPIENT_SESSION_TTL=86400
    volumes:
      - ./skills:/mnt/skills
      - ./sessions:/data/sessions
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:7337/v1/health"]
      interval: 30s
      timeout: 5s
      retries: 3
```

Run with Docker Compose:

```bash
docker compose up -d
```

Check logs:

```bash
docker compose logs -f seepient
```

Stop all services:

```bash
docker compose down
```

## Mounting Custom Skills

Mount a directory of custom skills into the container:

```bash
docker run -d \
  --name seepient \
  -p 7337:7337 \
  --env-file .env \
  -v $(pwd)/my-skills:/mnt/skills \
  seepient-server
```

Skills in `/mnt/skills/` are automatically discovered. Each skill is a subdirectory containing a `SKILL.md` file:

```
my-skills/
  code-review/
    SKILL.md
  deploy/
    SKILL.md
```

## Connecting to the Deployed Instance

### cURL

```bash
curl -X POST http://localhost:7337/v1/chat \
  -H "Content-Type: application/json" \
  -H "X-Seepient-API-Key: sk_seepient_..." \
  -d '{
    "message": "List files in the current directory",
    "tools": ["execute_shell_command"],
    "maxSteps": 3
  }'
```

### SDK

```typescript
import { generateText } from "seepient";

// Point at the Docker instance
const result = await generateText("Analyze the server logs", {
  tools: ["core"],
});
```

### Health Check

```bash
curl http://localhost:7337/v1/health
```

## Common Operations

```bash
# View logs
docker logs -f seepient

# Restart
docker restart seepient

# Stop
docker stop seepient

# Remove
docker rm seepient

# Update to latest
docker pull seepient-server:latest
docker stop seepient && docker rm seepient
docker run -d --name seepient ... seepient-server:latest
```

## Browser Tools (Playwright/Chromium)

The `read_website` and `take_screenshot` tools require Playwright with a Chromium browser. If your Docker image does not include Chromium, install it in your Dockerfile:

```dockerfile
# Install Chromium and dependencies for Playwright
RUN npx playwright install --with-deps chromium
```

For minimal images (Alpine), you also need CJK and emoji fonts for accurate screenshot rendering:

```dockerfile
RUN apk add --no-cache font-noto-cjk font-noto-emoji
```

For Debian/Ubuntu-based images:

```dockerfile
RUN apt-get update && apt-get install -y fonts-noto-cjk fonts-noto-color-emoji && rm -rf /var/lib/apt/lists/*
```

## Next Steps

- [Cloud Run Deployment](/examples/cloud-run-deploy) -- deploy to Google Cloud Run
- [Deploy as Backend Guide](/guides/deploy-as-backend) -- production deployment guide
- [Production Checklist](/guides/production-checklist) -- pre-deployment checklist
