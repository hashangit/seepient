---
title: createAgent()
description: Stateful multi-turn agent with session persistence, provider switching, and cumulative usage tracking.
---

# createAgent()

Create a persistent agent with session memory, provider switching, and abort support. Unlike `generateText()` which is stateless, an agent maintains conversation history across calls.

## Signature

```typescript
function createAgent(options?: AgentCreateOptions): Promise<SdkAgent>
```

::: warning
`createAgent()` is async -- always `await` it. The agent needs to resolve the provider configuration and optionally load persisted session state before it is ready.
:::

## Quick example

```typescript
import { createAgent } from "seepient";

const agent = await createAgent({
  model: "gpt-5.4",
  systemPrompt: "You are a concise coding assistant.",
});

const reply = await agent.chat("What is a closure?");
console.log(reply.text);

// Context is preserved across calls
const followUp = await agent.chat("Show me an example in TypeScript");
console.log(followUp.text);

// Check cumulative usage
console.log(agent.getUsage());
```

## Parameters

### `options` (optional)

`AgentCreateOptions` -- all fields optional:

| Name            | Type                                     | Default                    | Description |
|-----------------|------------------------------------------|----------------------------|-------------|
| `model`         | `string`                                 | Provider default           | Model identifier, e.g. `"gpt-5.4"`, `"claude-sonnet-4-6-20260320"` |
| `provider`      | `ProviderType`                           | Config default             | `"openai"` \| `"anthropic"` \| `"glm"` \| `"openai-compatible"` |
| `systemPrompt`  | `string`                                 | `"You are a helpful assistant."` | System prompt prepended to every conversation |
| `tools`         | `string[] \| UserToolDefinition[]`       | All built-in               | Tools available to the agent |
| `skills`        | `string[]`                               | *(none)*                   | Skill names to activate |
| `maxSteps`      | `number`                                 | `10`                       | Maximum agent loop iterations per call |
| `persist`       | `string \| PersistenceBackend \| PersistenceConfig` | *(none)*          | Directory path, backend instance, or config object (e.g. `{ type: "memory" }`). File persistence writes are **atomic** (tmp + rename). |
| `hooks`         | `Hooks`                                  | *(none)*                   | Lifecycle callbacks |
| `middleware`    | `Middleware[]`                            | *(none)*                   | Request/response pipeline functions (auth, logging, rate limiting, etc.) |
| `metadata`     | `Record<string, unknown>`                 | `{}`                       | Adapter-specific metadata passed to middleware via `PipelineContext` |
| `config`        | `Record<string, unknown>`                | `{}`                       | Extra config passed to tool handlers |

## SdkAgent interface

The object returned by `createAgent()`:

### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `chat` | `(message: string) => Promise<AgentResponse>` | Send a message and get the full response. Context is preserved. |
| `chatStream` | `(message: string, options?: StreamTextOptions) => Promise<StreamTextResult>` | Send a message with streaming output. Returns async iterables and SSE helpers. |
| `switchProvider` | `(provider: ProviderType, model?: string) => Promise<void>` | Switch the LLM provider (and optionally model) mid-conversation. |
| `setSystemPrompt` | `(prompt: string) => void` | Update the system prompt. Replaces the existing system message in history. |
| `setTools` | `(tools: string[]) => void` | Update the tool set available to the agent. |
| `abort` | `() => void` | Abort the currently running `chat()` or `chatStream()` call. Works correctly during streaming (v0.2.2+). |
| `clear` | `() => void` | Clear conversation history. Keeps the system prompt. |
| `getHistory` | `() => Message[]` | Return a copy of the full conversation history. |
| `getUsage` | `() => CumulativeUsage` | Return cumulative token usage across all calls. |

### AgentResponse

Returned by `chat()`:

```typescript
interface AgentResponse {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
}
```

### CumulativeUsage

Returned by `getUsage()`:

```typescript
interface CumulativeUsage {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCost: number;
  requestCount: number;
}
```

## Examples

### Basic multi-turn conversation

```typescript
import { createAgent } from "seepient";

const agent = await createAgent({
  systemPrompt: "You are a helpful travel advisor.",
});

const r1 = await agent.chat("What are the top 3 things to do in Tokyo?");
console.log(r1.text);

const r2 = await agent.chat("Which of those is best for families?");
console.log(r2.text);

// The agent remembers the full conversation
console.log(`History: ${agent.getHistory().length} messages`);
console.log(`Total requests: ${agent.getUsage().requestCount}`);
```

### Streaming responses

Use `chatStream()` for real-time output:

```typescript
const agent = await createAgent({
  model: "claude-sonnet-4-6-20260320",
  provider: "anthropic",
});

const stream = await agent.chatStream("Explain transformers architecture", {
  onText: (delta) => process.stdout.write(delta),
});

const text = await stream.fullText;
console.log(`\nTokens: ${(await stream.usage).totalTokens}`);
```

### Provider switching

Switch between providers mid-conversation:

```typescript
const agent = await createAgent({ provider: "openai", model: "gpt-5.4" });

// Start with OpenAI
const r1 = await agent.chat("What is the capital of France?");
console.log(r1.text);

// Switch to Anthropic for the next turn
await agent.switchProvider("anthropic", "claude-sonnet-4-6-20260320");

const r2 = await agent.chat("Tell me more about its history");
console.log(r2.text);
```

::: tip
`switchProvider()` changes the provider for subsequent calls. The conversation history is preserved, so context carries over seamlessly.
:::

### Session persistence

Persist conversation history so the agent can resume across process restarts:

```typescript
import { createAgent } from "seepient";

// Option 1: File-based persistence (backward compatible — just pass a path)
const agent = await createAgent({
  persist: "./sessions/my-agent",
});

// Option 2: In-memory persistence (great for testing)
const agent2 = await createAgent({
  persist: { type: "memory" },
});

// Option 3: Explicit file config
const agent3 = await createAgent({
  persist: { type: "file", path: "/var/data/sessions" },
});

await agent.chat("My name is Alice");
await agent.chat("I'm working on a React project");

// In a new process, recreate the agent with the same persist path:
// const agent2 = await createAgent({ persist: "./sessions/my-agent" });
// The conversation history will be loaded automatically.
```

#### Custom persistence backends

Register custom backends (Redis, SQLite, encrypted storage, etc.) with `registerBackend`:

```typescript
import { registerBackend, createAgent, type PersistenceBackend, type SessionData } from "seepient";

class RedisBackend implements PersistenceBackend {
  constructor(private url: string) { /* connect */ }

  async save(sessionId: string, data: SessionData): Promise<void> {
    await redis.set(`session:${sessionId}`, JSON.stringify(data));
  }
  async load(sessionId: string): Promise<SessionData | null> {
    const raw = await redis.get(`session:${sessionId}`);
    return raw ? JSON.parse(raw) : null;
  }
  async delete(sessionId: string): Promise<void> {
    await redis.del(`session:${sessionId}`);
  }
  async list(): Promise<string[]> {
    const keys = await redis.keys("session:*");
    return keys.map((k) => k.replace("session:", ""));
  }
}

// Register once at startup
registerBackend("redis", (config) => new RedisBackend(config.url as string));

// Then use by type name
const agent = await createAgent({
  persist: { type: "redis", url: "redis://localhost:6379" },
});
```

#### Pass a backend instance directly

::: warning Breaking change in v0.2.2
Custom `PersistenceBackend` implementations must include `readonly __persistenceBackend = true as const`. Without this brand field, the SDK will wrap your backend and strip `createdAt`, `provider`, `model`, and `metadata` from saved data.
:::

```typescript
const myBackend: PersistenceBackend = {
  readonly __persistenceBackend: true as const,
  async save(id, data) { /* custom logic */ },
  async load(id) { return null; },
  async delete(id) {},
  async list() { return []; },
};

const agent = await createAgent({ persist: myBackend });
```

### Dynamic tools

Change the available tools at runtime:

```typescript
const agent = await createAgent({
  tools: ["core"], // Only shell, read_file, write_file, datetime
});

await agent.chat("Read ./package.json and tell me the version");

// Add web search for the next query
agent.setTools(["core", "web_search"]);

await agent.chat("Now search for the latest version of this package on npm");
```

### Abort a running call

```typescript
const agent = await createAgent();

// Start a long-running request
const promise = agent.chat("Analyze all files in this repository");

// Abort after 5 seconds
setTimeout(() => agent.abort(), 5000);

try {
  const result = await promise;
} catch (err) {
  console.log("Agent was aborted");
}
```

::: info
`abort()` cancels the in-flight HTTP request to the LLM provider, not just the agent loop between steps. The `AbortSignal` propagates through to the underlying provider SDK (OpenAI, Anthropic, etc.), so network resources are released immediately.

**Concurrency:** As of v0.2.2, `chat()` and `chatStream()` are serialized — a second call blocks until the first completes. This prevents concurrent mutations of the shared message history.
:::

### Inspect history

```typescript
const agent = await createAgent();
await agent.chat("Hello");
await agent.chat("What can you do?");

const history = agent.getHistory();
for (const msg of history) {
  console.log(`[${msg.role}] ${msg.content.slice(0, 80)}`);
}

// Clear to start fresh
agent.clear();
console.log(agent.getHistory().length); // 1 (just the system prompt)
```

## Persistence types

### PersistenceBackend interface

```typescript
interface PersistenceBackend {
  /** Brand discriminator — distinguishes from SessionStore */
  readonly __persistenceBackend: true;
  save(sessionId: string, data: SessionData): Promise<void>;
  load(sessionId: string): Promise<SessionData | null>;
  delete(sessionId: string): Promise<void>;
  list(): Promise<string[]>;
}
```

### PersistenceConfig

```typescript
interface PersistenceConfig {
  type: string;           // "file", "memory", or custom registered type
  [key: string]: unknown; // Backend-specific options (path, url, etc.)
}
```

Built-in backends and factory functions:

- **`createPersistenceBackend(config)`** -- Creates a backend from a config object
- **`registerBackend(type, factory)`** -- Registers a custom backend type
- **`createSessionStore(path?)`** -- Legacy file-backed store (deprecated, use `createPersistenceBackend`)
- **`createMemoryStore()`** -- Legacy in-memory store (deprecated, use `{ type: "memory" }`)

## Middleware

Add cross-cutting concerns (logging, auth, rate limiting) to agent execution:

```typescript
import {
  createAgent,
  loggingMiddleware,
  rateLimitMiddleware,
  authMiddleware,
} from "seepient";

const agent = await createAgent({
  middleware: [
    authMiddleware({
      validate: (ctx) => !!ctx.metadata.apiKey,
      errorMessage: "Missing API key",
    }),
    rateLimitMiddleware({
      maxRequests: 60,
      windowMs: 60_000,
      keyExtractor: (ctx) => String(ctx.metadata.userId ?? "anonymous"),
    }),
    loggingMiddleware({
      logRequest: true,
      logResponse: true,
    }),
  ],
  metadata: { apiKey: process.env.MY_API_KEY, userId: "user-123" },
});
```

### Custom middleware

```typescript
import type { Middleware } from "seepient";

const auditLog: Middleware = async (ctx, next) => {
  console.log(`[audit] request ${ctx.requestId} started`);
  const start = Date.now();

  await next(); // Continue to the agent loop

  console.log(`[audit] request ${ctx.requestId} finished in ${Date.now() - start}ms`);
};

const agent = await createAgent({ middleware: [auditLog] });
```

## Related APIs

- [generateText()](/sdk/generate-text) -- Stateless one-shot execution
- [streamText()](/sdk/stream-text) -- Stateless streaming execution
- [Tools](/tools/reference) -- Built-in and custom tool reference
