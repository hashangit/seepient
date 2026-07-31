---
layout: home

hero:
  name: Seepient Agent
  tagline: Headless AI agent framework with multi-provider LLM support
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started/installation
    - theme: alt
      text: View on GitHub
      link: https://github.com/hashangit/seepient

features:
  - icon: ⚡
    title: Multi-Provider LLM
    details: Connect to OpenAI, Anthropic, GLM, and any OpenAI-compatible provider using your own API keys. Switch providers with a single line of code.
  - icon: 🛠️
    title: 12 Built-in Tools
    details: Shell execution, file operations, web search, email, screenshots, and more. Ready to use out of the box.
  - icon: 🎯
    title: Skills System
    details: Reusable AI behavior packages. Share and compose complex agent capabilities across projects.
  - icon: 🔧
    title: Functional API
    details: Clean, composable functions like `generateText`, `streamText`, and `createAgent` for any use case.
  - icon: 🐳
    title: Docker-Native
    details: Deploy anywhere as a container. Includes WebSocket + REST API server for production workloads.
  - icon: 🔒
    title: Type-Safe
    details: Full TypeScript with Zod schemas. Get autocomplete and type safety across your entire agent stack.
---

# Build AI Agents with Confidence

Seepient Agent is a headless AI agent framework that gives you the power to build intelligent, tool-capable agents with full control over your stack.

## Why Seepient Agent?

::: tip Developer Experience First
Seepient Agent is designed for developers who want full control over their AI agent architecture. No black boxes, no vendor lock-in, just clean, composable APIs.
:::

## Quick Look

```typescript
import { generateText } from 'seepient'

const result = await generateText('What is the capital of France?', {
  provider: 'openai',
  model: 'gpt-5.4'
})

console.log(result.text) // "The capital of France is Paris."
```

## Use It Anywhere

### As an SDK

```bash
npm install seepient
```

Build AI-powered features directly into your Node.js applications with full TypeScript support.

### As a CLI

```bash
npx seepient chat
```

Interact with AI agents from your terminal with the included command-line interface.

### As a Server

```bash
docker run -p 7337:7337 seepient/server
```

Deploy as a container with WebSocket + REST API for production workloads.

## What's Next?

::: info Choose Your Path
- **New to Seepient Agent?** Start with the [Installation Guide](/getting-started/installation)
- **Building an app?** Check out the [SDK Reference](/sdk/overview)
- **Deploying to production?** See the [Server API](/server/overview)
- **Looking for inspiration?** Browse our [Guides](/guides/build-your-own-ui)
:::

Get started in under 5 minutes with our [Quick Start guide](/getting-started/quick-start).
