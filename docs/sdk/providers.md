---
title: Providers
description: Multi-provider LLM support with OpenAI, Anthropic, GLM, and OpenAI-compatible backends.
---

# Providers

Seepient Agent supports multiple LLM providers with a unified interface. Bring your own API keys from each provider and switch seamlessly — all other code stays the same. Seepient Agent does not provide hosted LLM inference.

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

Pass `model` as an option:

```typescript
import { generateText } from "seepient";

const result = await generateText("Explain recursion", {
  model: "claude-sonnet-4-6-20260320",
});
```

## Environment variable auto-detection

Seepient Agent automatically detects API keys from environment variables.

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

```bash
# Use Anthropic with its own key
export ANTHROPIC_API_KEY=sk-ant-...
export LLM_PROVIDER=anthropic
```

---

## Embedder Catalog & Provider API

For multi-tenant applications and custom embedders, instantiate `createSeepient` to manage accounts, assignments, and query model catalogs:

```typescript
import { createSeepient } from "seepient";

// In-memory isolated instance (e.g. per-tenant or test runner)
const seepient = await createSeepient({
  overlayFile: ":memory:",
});

// List distinct upstream providers (e.g. ["anthropic", "google", "openai"])
const providers = await seepient.listProviders();

// Inspect full available models catalog
const catalog = await seepient.getCatalog();
console.log(`Found ${catalog.length} available models across providers:`, providers);

// Add a provider account programmatically
await seepient.addProvider({
  accountId: "team_anthropic",
  upstreamProvider: "anthropic",
  credential: { mode: "paste", keyValue: process.env.ANTHROPIC_API_KEY! },
});
```

---

## Per-Account Discovery with `createProviderManagerApi`

For fine-grained control over accounts and remote model discovery:

```typescript
import { createProviderManagerApi } from "seepient";

const manager = createProviderManagerApi(runtime);

// Retrieve current configuration state and accounts
const state = await manager.getState();

// Refresh discovered models from upstream API for an account
const refreshResult = await manager.refreshModels("team_anthropic");
if (refreshResult.ok) {
  console.log(`Discovered ${refreshResult.discoveredCount} models`);
}
```

---

## Runtime provider switching with agents

Use `agent.switchProvider()` to change the provider account (or model) mid-conversation:

```typescript
import { createAgent } from "seepient";

const agent = await createAgent({
  model: "gpt-5.4",
});

// First turn with the default provider account
const r1 = await agent.chat("What is the capital of France?");
console.log(r1.text);

// Switch to another configured provider account for the next turn
await agent.switchProvider("team_anthropic", "claude-opus-4-6-20260320");

const r2 = await agent.chat("Tell me more about its history");
console.log(r2.text);

// Switch models within the default account
await agent.switchProvider("opus");

const r3 = await agent.chat("Summarize in Chinese");
console.log(r3.text);
```

::: tip
`switchProvider(account, model)` targets a provider account from your configuration; with a single argument it switches the model only. The conversation history is fully preserved across switches.
:::

---

## OpenAI-compatible provider

Connect to any LLM API that exposes an OpenAI-compatible endpoint (Ollama, vLLM, Together AI, local models, self-hosted LLMs, third-party proxies):

```typescript
import { generateText } from "seepient";

const result = await generateText("Hello from local model", {
  model: "llama-3.3-70b",
  config: {
    openaiCompatBaseUrl: process.env.OPENAI_COMPAT_BASE_URL,
    openaiCompatApiKey: process.env.OPENAI_COMPAT_API_KEY,
  },
});
```

::: warning
The `OPENAI_COMPAT_BASE_URL` is required for the `openai-compatible` provider.
:::

---

## Related APIs

- [generateText()](/sdk/generate-text) -- Stateless text generation
- [createAgent()](/sdk/create-agent) -- Stateful agent with provider switching
- [Custom Tools](/sdk/custom-tools) -- Register custom tools and trust boundaries
- [Types](/sdk/types) -- Full TypeScript type reference
