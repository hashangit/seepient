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
import { askSeepient } from "seepient";

const result = await askSeepient("Explain recursion", {
  model: "claude-sonnet-4-6-20260320",
});
```

## Provider credentials

Credentials live in provider management, never in the environment.

Credentials are stored through provider management (setup wizard, TUI dock, `seepient auth login`), never read from the environment. Embedders can inject their own `CredentialStore` (see below).

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
  credential: { mode: "paste", keyValue: process.env.MY_COMPANY_ANTHROPIC_KEY! }, // embedder-owned env is fine — Seepient never reads it
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
import { createSeepient } from "seepient";

const agent = await createSeepient({
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

OpenAI-compatible endpoints (Ollama, vLLM, Together AI, local models, self-hosted LLMs, third-party proxies) are configured like any other provider: add an account with a base URL through provider management, with a stored key or `none` for keyless local servers.

Wire formats — model resolution is catalog-driven, and the resolved entry decides what the engine dials:

- A **catalog model id** (e.g. `gpt-5.4`) uses the OpenAI **Responses** API — requests go to `POST {baseUrl}/v1/responses`. Your endpoint must serve that path for catalog models.
- An endpoint that only speaks OpenAI **chat completions**: declare the model name on the account's `models` list. Non-catalog models fall back to the chat-completions wire (`POST {baseUrl}/v1/chat/completions`). An undeclared, non-catalog name fails with `unknown_model`.
- The `compat` field on a provider entry is accepted by the schema but **does not change wire selection** today.

## Related APIs

- [Provider Management API](/sdk/provider-management) -- Complete programmatic accounts, assignments, and runtime management
- [createSeepient()](/sdk/create-seepient) -- Stateful agent with provider switching
- [askSeepient()](/sdk/ask-seepient) -- Stateless one-shot execution (streaming via `stream: true`)
- [Custom Tools](/sdk/custom-tools) -- Register custom tools and trust boundaries
- [Types Reference](/sdk/types) -- Full TypeScript type reference
