---
title: Production Checklist
description: Pre-deployment checklist for running Seepient Agent in production.
---

# Production Checklist

Use this checklist before deploying Seepient Agent to production. Each item links to the relevant documentation or configuration.

## Authentication and Access

- [ ] **API keys generated** with appropriate scopes (`agent:run`, `agent:read`, etc.)
- [ ] **Tool permissions reviewed** -- only enable tools your application needs (avoid `execute_shell_command` unless required)
- [ ] **CORS configured** for allowed origins only (not `*`)
- [ ] **Rate limiting enabled** to prevent abuse (configure at infrastructure level via reverse proxy or API gateway)

## Environment and Configuration

- [ ] **All provider API keys set** via secrets management (not `.env` files in production)
- [ ] **Default provider and model configured** (`LLM_PROVIDER`, `OPENAI_MODEL` / `ANTHROPIC_MODEL` / `GLM_MODEL`)
- [ ] **Tavily API key set** if using `web_search` tool
- [ ] **SMTP credentials configured** if using `send_email` tool
- [ ] **Image generation model configured** if using `generate_image` tool
- [ ] **Notification webhooks configured** if using `send_notification` (Feishu, DingTalk, WeCom)

## Session and State Management

- [ ] **Session directory configured** (`SEEPIENT_SESSION_DIR`) -- use a persistent volume for Cloud Run or multi-instance deployments
- [ ] **Session cleanup schedule verified** -- ensure expired sessions are cleaned up
- [ ] **WebSocket heartbeat configured** (30s interval recommended)

## Deployment Configuration

- [ ] **Docker image built and tested** locally before pushing to registry
- [ ] **Cloud provider timeout settings** -- set to 3600s for Cloud Run to support long agent loops
- [ ] **Min instances set to 1** to prevent cold starts for interactive use
- [ ] **Max instances configured** based on expected concurrency
- [ ] **Memory allocation sufficient** -- 1 GiB minimum, 2 GiB if using browser tools
- [ ] **Volume mounted** for session persistence (if using file-based sessions)

## Monitoring and Observability

- [ ] **Health check endpoint monitored** (`GET /v1/health`) with alerting
- [ ] **Error alerting configured** for 5xx responses and provider failures
- [ ] **Cost tracking enabled** -- aggregate `usage.cost` from responses
- [ ] **Log aggregation set up** -- Seepient Agent outputs structured JSON logs to stdout
- [ ] **Token usage monitored** -- track `usage.totalTokens` to detect runaway loops

## Reliability

- [ ] **Graceful shutdown handling** -- ensure in-flight requests complete before termination
- [ ] **Retry logic implemented** on the client side for `PROVIDER_ERROR` and `GENERATION_ERROR` (use exponential backoff, max 3 retries)
- [ ] **Abort/cancellation supported** -- pass `AbortSignal` for user-initiated cancellation
- [ ] **Max steps configured** -- set `maxSteps` to prevent infinite agent loops (default: 10)

## Security

- [ ] **No secrets in code or Docker images** -- use secrets management
- [ ] **Container runs as non-root user** in production
- [ ] **Network policies restrict outbound access** where possible
- [ ] **Input validation** on all user-supplied messages before sending to the LLM
- [ ] **File path references restricted** -- Seepient Agent validates `@path` references are within allowed directories

## Quick Reference: Critical Environment Variables

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | At least one provider | OpenAI API key |
| `ANTHROPIC_API_KEY` | At least one provider | Anthropic API key |
| `GLM_API_KEY` | At least one provider | GLM API key |
| `LLM_PROVIDER` | No | Default LLM provider (`openai`, `anthropic`, `glm`, `openai-compatible`) |
| `OPENAI_MODEL` | No | Default OpenAI model (default: `gpt-5.4`) |
| `ANTHROPIC_MODEL` | No | Default Anthropic model (default: `claude-sonnet-4-6-20260320`) |
| `GLM_MODEL` | No | Default GLM model (default: `opus`) |
| `SEEPIENT_PORT` | No | Server port (default: 7337) |
| `SEEPIENT_SESSION_DIR` | No | Session storage directory (default: `./.seepient/sessions`) |
| `SEEPIENT_SESSION_TTL` | No | Session TTL in seconds (default: `86400`) |
| `TAVILY_API_KEY` | If using search | Tavily search API key |
| `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` | If using email | SMTP configuration |

## Next Steps

- [Deploy as Backend](/guides/deploy-as-backend) -- step-by-step deployment guide
- [Docker Deploy Example](/examples/docker-deploy) -- complete Docker walkthrough
- [Cloud Run Deploy Example](/examples/cloud-run-deploy) -- complete Cloud Run walkthrough
