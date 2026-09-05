---
title: Provider Management API
description: Manage LLM providers, credentials, model assignments, and catalog discovery programmatically with the Seepient SDK.
---

# Provider Management API

The Seepient SDK provides comprehensive APIs for configuring model providers, managing API credentials, defining purpose-and-tier routing assignments, discovering upstream models, and testing provider health.

Provider management is available at two levels:
1. **Agent Instance Methods**: Directly on instances returned by `createSeepient()` (Spec 013 / Spec 021 parity).
2. **Standalone Management API**: Via `createProviderManagerApi(runtime)` for embedders building control planes or dashboards.

---

## Agent Instance Management Methods

Every `Seepient` instance returned by `createSeepient()` exposes provider management methods that inspect and mutate the underlying provider runtime:

```typescript
import { createSeepient } from "seepient";

const agent = await createSeepient();
```

### Methods Summary

| Method | Signature | Description |
|---|---|---|
| `listProviders` | `() => Promise<string[]>` | List distinct upstream provider names (e.g. `["anthropic", "google", "openai"]`) |
| `getCatalog` | `() => Promise<readonly AvailableModel[]>` | Return all discovered and declared models across all configured accounts |
| `getAssignments` | `() => PurposeModelMap` | Return current purpose-and-tier routing assignments |
| `addProvider` | `(input: AccountInput) => Promise<SaveResult>` | Add or update a provider account with credentials |
| `removeProvider` | `(id: string, opts?: { force?: boolean }) => Promise<DeleteResult>` | Delete a configured provider account |
| `setAssignment` | `(purpose, tier, target) => Promise<SaveResult>` | Assign a model to a purpose and tier |
| `clearAssignment` | `(purpose, tier) => Promise<SaveResult>` | Remove an assignment for a purpose and tier |
| `resolve` | `(opts: { purpose, tier?, override? }) => Promise<ResolutionResult>` | Preview which model and account will be routed for a turn |
| `reload` | `() => Promise<{ revision: number }>` | Force-reload configuration state from the backing store |
| `dispose` | `() => Promise<void>` | Abort pending operations, flush audit events, and release listeners |

---

### Example: Inspecting Catalogs & Assignments

```typescript
import { createSeepient } from "seepient";

const agent = await createSeepient();

// 1. List available upstream providers
const providers = await agent.listProviders();
console.log("Configured upstream providers:", providers); // ["anthropic", "openai"]

// 2. Query available models
const catalog = await agent.getCatalog();
console.log(`Discovered ${catalog.length} available models:`);
for (const model of catalog) {
  console.log(` - ${model.id} (${model.displayName}) via [${model.reachableVia.join(", ")}]`);
}

// 3. Inspect current purpose-to-model assignments
const assignments = agent.getAssignments();
console.log("Text default:", assignments.text?.standard?.model);
```

---

### Example: Mutating Accounts & Assignments

```typescript
import { createSeepient } from "seepient";

const agent = await createSeepient();

// 1. Add a new Anthropic provider account programmatically
const saveRes = await agent.addProvider({
  accountId: "team_anthropic",
  upstreamProvider: "anthropic",
  credential: {
    mode: "paste",
    keyValue: process.env.ANTHROPIC_API_KEY!,
  },
});

if (saveRes.ok) {
  console.log("Account added successfully!");
}

// 2. Set the default 'text' purpose / 'standard' tier model
await agent.setAssignment("text", "standard", {
  providerAccount: "team_anthropic",
  model: "claude-sonnet-4-6-20260320",
});

// 3. Clear an assignment
await agent.clearAssignment("plan", "complex");

// 4. Remove a provider account
await agent.removeProvider("team_anthropic");
```

---

### Example: Turn Resolution Preview

Preview how Seepient will route an invocation without making an actual LLM call:

```typescript
const plan = await agent.resolve({
  purpose: "text",
  tier: "standard",
});

console.log(`Routed to model: ${plan.model.id}`);
console.log(`Using account: ${plan.providerAccount}`);
console.log(`Resolution via: ${plan.via}`); // "requested" or "fallback-chain"
```

---

## Standalone `createProviderManagerApi`

For multi-tenant management consoles, server routes, or background workers, use `createProviderManagerApi`:

```typescript
import {
  createProviderManagerApi,
  getDefaultProviderRuntime,
  ProviderRuntime,
} from "seepient";

const runtime = getDefaultProviderRuntime();
const manager = createProviderManagerApi(runtime);

// Retrieve complete state snapshot
const state = await manager.getState();
console.log(`Active revision: ${state.revision}`);
console.log(`Configured accounts: ${state.accounts.length}`);

// Test connectivity and validate an account
const probe = await manager.probeAccount("openai_main");
console.log(`Probe result: ok=${probe.ok}, latency=${probe.latencyMs}ms`);

// Refresh models dynamically from upstream provider API
const refresh = await manager.refreshModels("openai_main");
if (refresh.ok) {
  console.log(`Discovered ${refresh.discoveredCount} models`);
}
```

---

## In-Memory Isolated Runtimes

For test runners, serverless tasks, or strict multi-tenant isolation, bootstrap an agent with an ephemeral in-memory configuration store:

```typescript
import {
  createSeepient,
  ProviderConfigStore,
  MemoryCredentialStore,
} from "seepient";

const agent = await createSeepient({
  // Use ":memory:" so no files are written to disk
  overlayFile: ":memory:",
  
  // Provide isolated accounts
  providers: {
    isolated_openai: {
      adapter: "pi-ai",
      upstreamProvider: "openai",
      credential: { kind: "env", name: "OPENAI_API_KEY" },
    },
  },

  // Provide initial purpose mappings
  modelAssignments: {
    text: {
      standard: { providerAccount: "isolated_openai", model: "gpt-5.4" },
    },
  },
});

// Everything executes within the isolated in-memory runtime
const response = await agent.chat("Hello from isolated agent!");
console.log(response.text);

await agent.dispose();
```

---

## OAuth Helpers

Seepient supports OAuth 2.0 PKCE authentication for providers that support web sign-in (e.g., Anthropic, Google Cloud). The SDK exports helpers to check support and retrieve canonical flow identifiers:

```typescript
import { isOAuthSupported, getCanonicalOAuthFlowId } from "seepient";

if (isOAuthSupported("anthropic")) {
  const flowId = getCanonicalOAuthFlowId("anthropic");
  console.log(`Anthropic OAuth flow: ${flowId}`); // "anthropic-pkce"
}

console.log(isOAuthSupported("openai")); // false (OpenAI uses API keys)
```

---

## Purpose & Tier Model Routing

Seepient routes LLM invocations using semantic **purposes** and capability **tiers** rather than hardcoding model names:

### Purposes

| Purpose | Description |
|---|---|
| `"plan"` | Architectural planning, reasoning, and multi-step decomposition |
| `"text"` | General dialogue, Q&A, and user communication |
| `"coding"` | Code generation, refactoring, and bug fixes |
| `"vision"` | Multimodal image understanding and UI analysis |
| `"commit"` | Commit message generation and patch summaries |
| `"data"` | Data analysis, schema synthesis, and transformation |
| `"dreaming"` | Background compaction, reflection, and memory consolidation |
| `"media.image"` | Image generation and visual artifact synthesis |
| `"media.speech"` | Text-to-speech synthesis |
| `"media.transcription"` | Speech-to-text audio transcription |
| `"media.video"` | Video generation |

### Tiers

- **`"efficient"`**: Fast, cost-effective models (e.g. `gpt-5.4-mini`, `claude-haiku-4-5`).
- **`"standard"`**: Balanced flagship models for daily work (e.g. `gpt-5.4`, `claude-sonnet-4-6-20260320`).
- **`"complex"`**: Heavy reasoning and deep research models (e.g. `o3`, `claude-opus-4-6-20260320`).

---

## Related APIs

- [createSeepient()](/sdk/create-seepient) — Stateful agent factory
- [Providers Overview](/sdk/providers) — Multi-provider concepts
- [Types Reference](/sdk/types) — Complete TypeScript types for `AccountInput`, `SaveResult`, `ManagerState`, etc.
