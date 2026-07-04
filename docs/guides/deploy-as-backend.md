---
title: Deploy as a Backend Service
description: Deploy Seepient Agent as a production backend service using Docker or Google Cloud Run.
---

# Deploy as a Backend Service

Seepient Agent runs as a standalone server with REST and WebSocket APIs. This guide covers deploying it as a containerized backend service suitable for production workloads.

## Prerequisites

- Docker installed locally
- LLM provider API keys (OpenAI, Anthropic, and/or GLM)
- (Optional) Google Cloud SDK for Cloud Run deployment
- (Optional) Redis for session externalization

## Step 1: Build the Docker Image

Seepient Agent ships with a Dockerfile. Build the image:

```bash
git clone https://github.com/seepient/seepient.git
cd seepient
docker build -t seepient-server .
```

Verify the build:

```bash
docker run --rm seepient-server --version
```

## Step 2: Configure Environment Variables

Seepient Agent uses environment variables for provider keys and server configuration. Create a `.env` file:

```bash
# LLM Provider Keys (set at least one)
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GLM_API_KEY=...

# Default provider and model
LLM_PROVIDER=openai
OPENAI_MODEL=gpt-5.4

# Server settings
SEEPIENT_PORT=7337
SEEPIENT_PORT=7337

# Optional: Tavily for web search
TAVILY_API_KEY=tvly-...

# Optional: SMTP for email tool
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your@email.com
SMTP_PASS=app-password

# Optional: Image generation model override
IMAGE_MODEL=dall-e-3

# Session storage (default: file-based)
# SEEPIENT_SESSION_DIR=/data/sessions
```

::: warning Never commit .env files
Add `.env` to your `.gitignore`. Use your deployment platform's secret management for production.
:::

## Step 3: Deploy to Cloud Run

Deploy to Google Cloud Run for serverless scaling:

```bash
# Tag and push to Artifact Registry
gcloud auth configure-docker
docker tag seepient-server gcr.io/YOUR_PROJECT/seepient-server
docker push gcr.io/YOUR_PROJECT/seepient-server

# Deploy to Cloud Run
gcloud run deploy seepient-server \
  --image gcr.io/YOUR_PROJECT/seepient-server \
  --platform managed \
  --region us-central1 \
  --port 7337 \
  --timeout 3600 \
  --min-instances 1 \
  --max-instances 10 \
  --memory 1Gi \
  --set-env-vars "OPENAI_API_KEY=sk-..." \
  --set-secrets "ANTHROPIC_API_KEY=anthropic-key:latest"
```

::: tip Timeout Setting
Cloud Run's default timeout is 60 seconds. Set `--timeout 3600` (1 hour) to support long-running agent loops with multiple tool calls.
:::

### Alternative: Plain Docker

Run locally or on any Docker host:

```bash
docker run -d \
  --name seepient \
  -p 7337:7337 \
  --env-file .env \
  -v seepient-sessions:/data/sessions \
  seepient-server
```

## Step 4: Generate API Keys

Seepient Agent includes API key management for securing your deployment. Generate keys using the CLI or server endpoint:

```bash
# Via CLI (if running locally)
seepient server keygen --scopes agent:run,agent:read
```

Store the generated key securely. Clients must include it in requests:

```bash
curl http://your-server/v1/chat \
  -H "X-Seepient-API-Key: sk_seepient_..." \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello"}'
```

## Step 5: Connect from Client

Point your SDK client or HTTP calls at the deployed server:

### SDK Configuration

```typescript
import { configureProviders } from "seepient";

configureProviders({
  openai: { apiKey: process.env.OPENAI_API_KEY },
  default: "openai",
});
```

### Direct HTTP

```javascript
const response = await fetch("https://your-server.run.app/v1/chat", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Seepient-API-Key": "sk_seepient_...",
  },
  body: JSON.stringify({
    message: "Analyze this dataset",
    tools: ["core", "web_search"],
    maxSteps: 10,
  }),
});

const result = await response.json();
```

### Streaming via WebSocket

```javascript
const ws = new WebSocket("wss://your-server.run.app/ws?token=sk_seepient_...");

ws.onopen = () => {
  ws.send(JSON.stringify({
    type: "chat",
    id: crypto.randomUUID(),
    message: "Write a report on AI trends",
    options: { maxSteps: 10 }
  }));
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === "text") {
    process.stdout.write(msg.delta);
  } else if (msg.type === "done") {
    console.log("\nDone. Cost:", msg.usage.cost);
    ws.close();
  }
};
```

## Production Considerations

### Session Externalization

Cloud Run instances are ephemeral. For multi-turn conversations, mount a persistent volume for session storage:

```bash
# Set the session directory to a mounted volume
SEEPIENT_SESSION_DIR=/data/sessions
```

::: warning Future: Redis sessions
Redis-based session storage is planned but not yet implemented. Use file-based sessions with a persistent volume for now.
:::

### CORS Configuration

CORS is enabled by default and mirrors the request `Origin` header. For production, configure a reverse proxy (nginx, Cloud Load Balancer) to restrict origins.

### Rate Limiting

Implement rate limiting at the infrastructure level using a reverse proxy, API gateway, or Cloud Armor. Seepient Agent does not currently include built-in rate limiting.

### Resource Limits

| Setting | Recommended | Notes |
|---|---|---|
| Memory | 1 GiB | Increase to 2 GiB if using screenshots heavily |
| CPU | 1-2 vCPU | Tool execution is CPU-bound during browser automation |
| Timeout | 3600s | Long agent loops need extended timeouts |
| Min instances | 1 | Prevents cold starts for interactive use |
| Max instances | 10 | Scale based on your concurrent user count |

## Monitoring and Logging

Seepient Agent logs structured JSON to stdout, making it compatible with standard log aggregation tools.

### Health Check Monitoring

Monitor the health endpoint:

```bash
curl https://your-server.run.app/v1/health
```

Set up alerts when the endpoint returns non-200 or when `uptime` drops unexpectedly.

### Log Aggregation

For Cloud Run, logs flow automatically to Cloud Logging. For Docker deployments, use:

```bash
# Stream logs
docker logs -f seepient

# Send to external service
docker logs seepient 2>&1 | your-log-shipper
```

### Cost Tracking

Seepient Agent reports token usage and estimated cost in every response. Aggregate `usage.cost` across requests to track spending:

```typescript
import { generateText } from "seepient";

const result = await generateText("Hello", { tools: ["core"] });
console.log(`Cost: $${result.usage.cost.toFixed(4)}`);
console.log(`Tokens: ${result.usage.totalTokens}`);
```

## Next Steps

- [Production Checklist](/guides/production-checklist) -- pre-deployment checklist
- [Docker Deploy Example](/examples/docker-deploy) -- complete Docker walkthrough
- [Cloud Run Deploy Example](/examples/cloud-run-deploy) -- complete Cloud Run walkthrough
