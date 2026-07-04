---
title: Providers
description: Multi-provider LLM support with OpenAI, Anthropic, GLM, and OpenAI-compatible backends.
---

# Providers

Seepient Agent supports multiple LLM providers with a unified interface. Bring your own API keys from each provider and switch with a single option — all other code stays the same. Seepient Agent does not provide LLM inference.

## ProviderType

```typescript
type ProviderType = "openai" | "anthropic" | "glm" | "openai-compatible";
```

| Provider              | Value                  | Default model     |
| --------------------- | ---------------------- | ----------------- |
| OpenAI                | `"openai"`             | `gpt-5.4`          |
| Anthropic             | `"anthropic"`          | `claude-sonnet-4-6-20260320` |
| GLM                   | `"glm"`                | `opus`         |
| OpenAI-compatible     | `"openai-compatible"`  | `gpt-5.4` (configurable) |

## Available models

### OpenAI

| Model ID            | Display Name      |
| ------------------- | ----------------- |
| `gpt-5.4`           | GPT-5.4           |
| `gpt-5.4-pro`       | GPT-5.4 Pro       |
| `gpt-5.4-mini`      | GPT-5.4 Mini      |
| `gpt-5.4-nano`      | GPT-5.4 Nano      |
| `gpt-5.3-instant`   | GPT-5.3 Instant   |
| `gpt-5.3-codex`     | GPT-5.3 Codex     |
| `o3`                | o3                |
| `o3-mini`           | o3 Mini           |

### Anthropic

| Model ID                        | Display Name      |
| ------------------------------- | ----------------- |
| `claude-sonnet-4-6-20260320`    | Claude Sonnet 4.6 |
| `claude-opus-4-6-20260320`      | Claude Opus 4.6   |
| `claude-haiku-4-5-20251001`     | Claude Haiku 4.5  |

### GLM

| Alias     | Model ID        | Display Name   |
| --------- | --------------- | -------------- |
| `haiku`   | `glm-4.5-air`   | GLM-4.5 Air    |
| `sonnet`  | `glm-4.7`       | GLM-4.7        |
| `opus`    | `glm-5.1`       | GLM-5.1        |

::: tip
GLM accepts both the alias (`"haiku"`, `"sonnet"`, `"opus"`) and the full model ID. Aliases are automatically resolved.
:::

## Quick usage

Pass `provider` and `model` as options:

```typescript
import { generateText } from "seepient";

const result = await generateText("Explain recursion", {
  provider: "anthropic",
  model: "claude-sonnet-4-6-20260320",
});
```

## Environment variable auto-detection

Seepient Agent automatically detects API keys from environment variables. No code changes needed to switch providers.

### Provider-specific keys

| Environment Variable  | Provider   |
| --------------------- | ---------- |
| `OPENAI_API_KEY`      | OpenAI     |
| `ANTHROPIC_API_KEY`   | Anthropic  |
| `GLM_API_KEY`         | GLM        |
| `OPENAI_COMPAT_API_KEY` | OpenAI-compatible (Ollama, vLLM, Together AI, etc.) |

### Generic keys

| Environment Variable    | Purpose                                      |
| ----------------------- | -------------------------------------------- |
| `OPENAI_COMPAT_BASE_URL` | Base URL for the OpenAI-compatible provider (required when using that provider) |
| `OPENAI_COMPAT_MODEL` | Model name at your inference provider (default: `gpt-5.4`) |
| `LLM_PROVIDER`        | Default provider: `"openai"`, `"anthropic"`, `"glm"`, or `"openai-compatible"` |
| `LLM_MODEL`           | Generic model override for any provider (lower priority than provider-specific `*_MODEL` vars) |

### Resolution order

1. **Provider-specific env var** (e.g. `OPENAI_API_KEY`) -- highest priority
2. **Error** -- if the selected provider's key is not set

```bash
# Use Anthropic with its own key
export ANTHROPIC_API_KEY=sk-ant-...
export LLM_PROVIDER=anthropic
```

## `configureProviders()`

Set up multiple providers programmatically at application startup:

```typescript
import { configureProviders } from "seepient";

configureProviders({
  openai: {
    apiKey: process.env.OPENAI_API_KEY!,
    model: "gpt-5.4",
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY!,
    model: "claude-sonnet-4-6-20260320",
  },
  glm: {
    apiKey: process.env.GLM_API_KEY!,
    model: "opus",
  },
  default: "openai",
});
```

### MultiProviderConfig

```typescript
interface MultiProviderConfig {
  openai?: { apiKey: string; model?: string };
  anthropic?: { apiKey: string; model?: string };
  glm?: { apiKey: string; model?: string };
  "openai-compatible"?: { apiKey: string; baseUrl: string; model?: string };
  default: ProviderType;
}
```

## `provider()` factory

Build individual provider config objects:

```typescript
import { provider, configureProviders } from "seepient";

configureProviders({
  openai: provider("openai", "sk-...", { model: "gpt-5.4" }),
  anthropic: provider("anthropic", "sk-ant-..."),
  default: "openai",
});
```

The `provider()` function returns a typed config object with `{ type, apiKey, model?, baseUrl?, timeout? }`:

```typescript
function provider(
  type: ProviderType,
  apiKey: string,
  options?: { model?: string; baseUrl?: string; timeout?: number },
): ProviderConfig
```

## Per-request provider override

Every SDK function accepts `provider` and `model` options that override the global default:

```typescript
import { generateText } from "seepient";

// Uses the globally configured default provider
const r1 = await generateText("Hello");

// Overrides to Anthropic for this request only
const r2 = await generateText("Hello", {
  provider: "anthropic",
  model: "claude-sonnet-4-6-20260320",
});

// Uses GLM with the opus alias
const r3 = await generateText("Hello", {
  provider: "glm",
  model: "opus",
});
```

## Runtime provider switching with agents

Use `agent.switchProvider()` to change providers mid-conversation:

```typescript
import { createAgent } from "seepient";

const agent = await createAgent({
  provider: "openai",
  model: "gpt-5.4",
});

// First turn with OpenAI
const r1 = await agent.chat("What is the capital of France?");
console.log(r1.text);

// Switch to Anthropic for the next turn
await agent.switchProvider("anthropic", "claude-opus-4-6-20260320");

const r2 = await agent.chat("Tell me more about its history");
console.log(r2.text);

// Switch to GLM
await agent.switchProvider("glm", "opus");

const r3 = await agent.chat("Summarize in Chinese");
console.log(r3.text);
```

::: tip
`switchProvider()` changes the provider for subsequent calls only. The conversation history is fully preserved across switches.
:::

## OpenAI-compatible provider

Connect to any LLM API that exposes an OpenAI-compatible endpoint (Ollama, vLLM, Together AI, local models, self-hosted LLMs, third-party proxies):

```typescript
import { generateText } from "seepient";

const result = await generateText("Hello from local model", {
  provider: "openai-compatible",
  model: "llama-3.3-70b",
  apiKey: process.env.OPENAI_COMPAT_API_KEY,
  baseUrl: process.env.OPENAI_COMPAT_BASE_URL,
});
```

Or configure it globally:

```typescript
import { configureProviders } from "seepient";

configureProviders({
  "openai-compatible": {
    apiKey: process.env.OPENAI_COMPAT_API_KEY!,
    baseUrl: process.env.OPENAI_COMPAT_BASE_URL!,
    model: "llama-3.3-70b",
  },
  default: "openai-compatible",
});
```

::: warning
The `baseUrl` option is required for the `openai-compatible` provider. It is ignored for the other providers.
:::

## Dynamic provider management

Add, update, or remove providers at runtime:

```typescript
import {
  addProvider,
  updateProviderConfig,
  removeProvider,
} from "seepient";

// Add a new provider
addProvider("anthropic", {
  apiKey: "sk-ant-...",
  model: "claude-sonnet-4-6-20260320",
});

// Update just the model, keep existing apiKey
updateProviderConfig("openai", { model: "gpt-5.4-mini" });

// Remove a provider
removeProvider("glm");
```

## Auto-detection from environment

Use `resolveFromEnv()` to scan environment variables and build a `MultiProviderConfig` automatically:

```typescript
import { configureProviders, resolveFromEnv } from "seepient";

const envConfig = resolveFromEnv();
if (envConfig) {
  configureProviders(envConfig);
}
```

This is particularly useful for server deployments where configuration comes from environment variables.

## Related APIs

- [generateText()](/sdk/generate-text) -- Per-request provider override
- [createAgent()](/sdk/create-agent) -- Runtime provider switching
- [Types](/sdk/types) -- Full TypeScript type reference
