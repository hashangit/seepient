---
title: SDK Overview
description: Seepient Agent SDK architecture, installation, and quick-start guide.
---

# SDK Overview

Seepient Agent is a headless AI agent framework for building LLM-powered applications. The SDK provides a functional, composable API -- no class hierarchies, no boilerplate. Import a function, pass a prompt, get a result.

## Architecture

Seepient Agent is organized in three layers of increasing statefulness:

```
generateText()   -- One-shot. Stateless. No memory between calls.
createAgent()    -- Stateful. Multi-turn with session persistence.
Server           -- Remote. REST + WebSocket for distributed deployments.
```

Every layer delegates to the same core agent loop, so tool execution, hook lifecycle, abort handling, and usage tracking behave identically regardless of which entry point you use.

### Functional API philosophy

The SDK is built around plain functions and plain objects, not class instances:

- **`generateText(prompt, options?)`** -- returns a `Promise<GenerateTextResult>`
- **`streamText(prompt, options?)`** -- returns a `Promise<StreamTextResult>` with async iterables
- **`createAgent(options?)`** -- returns a `Promise<SdkAgent>` with `.chat()`, `.chatStream()`, and lifecycle methods

Configuration is passed as options objects. Return types are plain interfaces. There are no base classes to extend.

## Installation

::: tip Prerequisites
Seepient Agent requires **Node.js >= 22.19.0**.
:::

::: code-group

```bash [npm]
npm install seepient
```

```bash [pnpm]
pnpm add seepient
```

```bash [yarn]
yarn add seepient
```

:::

## Import patterns

::: code-group

```typescript [ESM -- recommended]
import { generateText, streamText, createAgent } from "seepient";
```

```typescript [SDK types only]
import type {
  GenerateTextOptions,
  GenerateTextResult,
  StreamTextResult,
  SdkAgent,
} from "seepient";
```

```typescript [Tools and factories]
import { trustedHostTool, CORE_TOOLS, COMM_TOOLS, ADVANCED_TOOLS, ALL_TOOLS } from "seepient";
```

```typescript [React integration]
import { createUseChat } from "seepient/react";
```

```typescript [Server]
import { createServer } from "seepient/server";
```

:::

## Quick examples

### One-shot text generation

```typescript
import { generateText } from "seepient";

const result = await generateText("Explain recursion in one paragraph");
console.log(result.text);
console.log(result.usage.totalTokens);
```

### Streaming

```typescript
import { streamText } from "seepient";

const stream = await streamText("Write a haiku about programming", {
  onText: (delta) => process.stdout.write(delta),
});

const finalText = await stream.fullText;
```

### Multi-turn agent

```typescript
import { createAgent } from "seepient";

const agent = await createAgent({
  model: "gpt-5.4",
  systemPrompt: "You are a concise coding assistant.",
});

const reply = await agent.chat("What is a closure in JavaScript?");
console.log(reply.text);

// Context is preserved -- follow-up questions work naturally
const followUp = await agent.chat("Show me an example");
console.log(followUp.text);
```

### Custom tools

```typescript
import { generateText, trustedHostTool } from "seepient";

const weatherTool = trustedHostTool({
  definition: {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get the current weather for a city",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string", description: "City name" },
        },
        required: ["city"],
      },
    },
  },
  execute: async (args) => {
    const { city } = (args ?? {}) as { city: string };
    return `Weather in ${city}: 72F, sunny`;
  },
});

const result = await generateText("What is the weather in Tokyo?", {
  permissionPipeline: true,
  tools: [weatherTool],
});
```

### HTTP SSE endpoint

```typescript
import { streamText } from "seepient";

app.get("/chat", async (req, res) => {
  const stream = await streamText(req.query.prompt as string);
  return stream.toResponse();
});
```

## Provider support

Seepient Agent supports multiple LLM providers out of the box:

| Provider         | `provider` value      | Default model                  |
| ---------------- | --------------------- | ------------------------------ |
| OpenAI           | `"openai"`            | `gpt-5.4`                       |
| Anthropic        | `"anthropic"`         | `claude-sonnet-4-6-20260320`     |
| GLM              | `"glm"`               | `opus`                          |
| OpenAI-compatible| `"openai-compatible"` | `gpt-5.4` (configurable `baseUrl`) |

Configure providers via environment variables, `.env`, or the `seepient setup` CLI wizard.

## Built-in tools

Seepient Agent ships with a set of built-in tools organized into groups:

| Group      | Tools                                                       |
| ---------- | ----------------------------------------------------------- |
| **Core**   | `execute_shell_command`, `read_file`, `write_file`, `get_current_datetime` |
| **Comm**   | `send_email`, `web_search`, `send_notification`             |
| **Advanced**| `read_website`, `take_screenshot`, `generate_image`, `optimize_prompt`, `use_skill` |

Pass tool names as strings, or use group names (`"core"`, `"comm"`, `"advanced"`, `"all"`) to include entire groups.

## API reference pages

| Page | Description |
|------|-------------|
| [generateText()](/sdk/generate-text) | One-shot agent execution with tools, hooks, and structured output |
| [streamText()](/sdk/stream-text) | Streaming execution with async iterables and SSE helpers |
| [createAgent()](/sdk/create-agent) | Stateful multi-turn agent with session persistence |
