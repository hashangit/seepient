---
title: Cloud Run Deployment
description: Deploy Seepient Agent to Google Cloud Run with Redis session storage and monitoring.
---

# Cloud Run Deployment

Deploy Seepient Agent to Google Cloud Run for serverless, auto-scaling agent workloads. This example covers the full setup including session externalization with Redis and monitoring.

## Prerequisites

- Google Cloud SDK (`gcloud`) installed and authenticated
- A Google Cloud project with billing enabled
- At least one LLM provider API key
- Seepient Agent Docker image built (see [Docker Deployment](/examples/docker-deploy))

## Step 1: Configure Google Cloud

```bash
# Set your project
gcloud config set project YOUR_PROJECT_ID

# Enable required APIs
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  redis.googleapis.com
```

## Step 2: Push the Docker Image

Build and push to Artifact Registry:

```bash
# Create a repository (one-time)
gcloud artifacts repositories create seepient \
  --repository-format=docker \
  --location=us-central1

# Build and push
docker tag seepient-server us-central1-docker.pkg.dev/YOUR_PROJECT_ID/seepient/server
docker push us-central1-docker.pkg.dev/YOUR_PROJECT_ID/seepient/server
```

## Step 3: Store Secrets

Store API keys in Secret Manager:

```bash
# Create secrets
echo -n "sk-..." | gcloud secrets create openai-api-key --data-file=-
echo -n "sk-ant-..." | gcloud secrets create anthropic-api-key --data-file=-
echo -n "tvly-..." | gcloud secrets create tavily-api-key --data-file=-
```

## Step 4: Configure Session Persistence

Cloud Run instances are ephemeral. Mount a persistent volume for session storage:

```bash
# Sessions will be stored in /data/sessions inside the container
# Set SEEPIENT_SESSION_DIR=/data/sessions in your deployment
```

::: warning File-based sessions on Cloud Run
File-based sessions do not persist across Cloud Run instances. For production multi-instance deployments, use a mounted Cloud Run volume or implement a custom session store. Redis-based session storage is planned for a future release.
:::

## Step 5: Deploy to Cloud Run

```bash
gcloud run deploy seepient-server \
  --image us-central1-docker.pkg.dev/YOUR_PROJECT_ID/seepient/server \
  --platform managed \
  --region us-central1 \
  --port 7337 \
  --timeout 3600 \
  --min-instances 1 \
  --max-instances 10 \
  --memory 1Gi \
  --cpu 2 \
  --set-env-vars "\
LLM_PROVIDER=openai,\
OPENAI_MODEL=gpt-5.4,\
SEEPIENT_PORT=7337,\
SEEPIENT_SESSION_DIR=/data/sessions,\
SEEPIENT_SESSION_TTL=86400" \
  --set-secrets "\
OPENAI_API_KEY=openai-api-key:latest,\
ANTHROPIC_API_KEY=anthropic-api-key:latest,\
TAVILY_API_KEY=tavily-api-key:latest" \
  --allow-unauthenticated
```

### Key Settings Explained

| Setting | Value | Why |
|---|---|---|
| `--timeout 3600` | 1 hour | Agent loops with tools can take minutes. Default 60s is too short. |
| `--min-instances 1` | Always warm | Prevents cold starts for interactive chat. |
| `--max-instances 10` | Auto-scale | Scale up under load, scale down when idle. |
| `--memory 1Gi` | 1 GB | Sufficient for most workloads. Use 2 GiB for heavy browser tool usage. |

## Step 6: Verify the Deployment

```bash
# Get the service URL
SERVICE_URL=$(gcloud run services describe seepient-server \
  --region us-central1 \
  --format 'value(status.url)')

# Health check
curl ${SERVICE_URL}/v1/health

# Test chat
curl -X POST ${SERVICE_URL}/v1/chat \
  -H "Content-Type: application/json" \
  -H "X-Seepient-API-Key: sk_seepient_..." \
  -d '{
    "message": "Hello! What tools do you have available?",
    "tools": [],
    "maxSteps": 3
  }'
```

## Monitoring Setup

### Cloud Logging

Seepient Agent outputs structured JSON logs to stdout. Cloud Run automatically sends these to Cloud Logging. View them:

```bash
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=seepient-server" \
  --limit 50 \
  --format json
```

### Health Check Alerting

Create an alert for health check failures:

```bash
gcloud alpha monitoring policies create \
  --display-name "Seepient Agent Health Check" \
  --condition-display-name "Health endpoint failing" \
  --condition-filter 'resource.type="cloud_run_revision" AND resource.labels.service_name="seepient-server" AND httpRequest.status>=500' \
  --condition-threshold-value 5 \
  --notification-channels=YOUR_CHANNEL_ID
```

### Custom Metrics

Track token usage and cost by logging structured data:

```bash
# Example: create a log-based metric for token usage
gcloud logging metrics create seepient-token-usage \
  --description="Total tokens consumed per request" \
  --log-filter='resource.type="cloud_run_revision" AND resource.labels.service_name="seepient-server" AND jsonPayload.type="usage"'
```

## Updating the Deployment

```bash
# Build and push new image
docker build -t seepient-server .
docker tag seepient-server us-central1-docker.pkg.dev/YOUR_PROJECT_ID/seepient/server
docker push us-central1-docker.pkg.dev/YOUR_PROJECT_ID/seepient/server

# Cloud Run automatically pulls the latest image on new revision
gcloud run deploy seepient-server \
  --image us-central1-docker.pkg.dev/YOUR_PROJECT_ID/seepient/server \
  --region us-central1
```

## WebSocket Considerations

Cloud Run supports HTTP/1.1 and HTTP/2, including long-lived connections. For WebSocket support:

- Use `--timeout 3600` to allow long-lived connections.
- Implement a heartbeat (30-second interval) to prevent connection drops.
- Consider using SSE (Server-Sent Events) instead of WebSockets for simpler streaming. Seepient Agent's `toResponse()` already produces SSE output.

## Cost Optimization

| Strategy | How |
|---|---|
| Min instances | Set to `0` for dev/test environments (accepts cold starts) |
| Concurrency | Increase `--concurrency` (default 80) if requests are short |
| Region | Deploy close to your users and Redis instance |
| Provider choice | Use `gpt-5.4-nano` or `claude-haiku-4-5-20251001` for non-critical paths |

## Cleanup

```bash
# Delete the Cloud Run service
gcloud run services delete seepient-server --region us-central1

# Delete secrets
gcloud secrets delete openai-api-key
gcloud secrets delete anthropic-api-key
gcloud secrets delete tavily-api-key

# Delete the artifact repository
gcloud artifacts repositories delete seepient --location us-central1
```

## Next Steps

- [Docker Deployment](/examples/docker-deploy) -- simpler local Docker setup
- [Deploy as Backend Guide](/guides/deploy-as-backend) -- general deployment guide
- [Production Checklist](/guides/production-checklist) -- pre-deployment checklist
