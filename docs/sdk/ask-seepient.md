---
title: askSeepient()
description: One-shot agent execution -- send a prompt, get a structured result, with optional streaming via async iterables and HTTP SSE helpers.
---

# askSeepient()

Run a one-shot agent loop. Creates fresh state for each call (stateless). Handles tool calls automatically until the provider returns no more tool calls or `maxSteps` is reached.

By default it returns a structured `AskSeepientResult`. Pass `stream: true` to get an `AskSeepientStreamResult` with async iterables (`textStream`, `steps`) and Web API SSE helpers (`toResponse()`, `toSSEStream()`).

## Signature

```typescript
// Non-streaming (default)
function askSeepient(
  prompt: string,
  options?: AskSeepientOptions & { stream?: false },
): Promise<AskSeepientResult>

// Streaming
function askSeepient(
  prompt: string,
  options: AskSeepientOptions & { stream: true },
): Promise<AskSeepientStreamResult>
```

## Quick example

```typescript
import { askSeepient } from "seepient";

// Non-streaming one-shot
const result = await askSeepient("What is the weather in San Francisco?", {
  tools: ["web_search"],
  maxSteps: 5,
});

console.log(result.text);
// => "The current weather in San Francisco is 65F with light fog..."

console.log(result.toolCalls.length);
// => 1  (the web_search call)

console.log(result.usage);
// => { promptTokens: 342, completionTokens: 128, totalTokens: 470, cost: 0 }

// Streaming one-shot
const stream = await askSeepient("Explain quantum computing simply", {
  stream: true,
  onText: (delta) => process.stdout.write(delta),
});

const finalText = await stream.fullText;
```

## Parameters

### `prompt` (required)

| Type     | Description                 |
| -------- | --------------------------- |
| `string` | The user message to process |

### `options` (optional)

`AskSeepientOptions` -- all fields optional:

| Name            | Type                                     | Default | Description |
|-----------------|------------------------------------------|---------|-------------|
| `stream`        | `boolean`                                | `false` | Return an `AskSeepientStreamResult` instead of `AskSeepientResult` |
| `model`         | `string`                                 | Provider default | Model identifier, e.g. `"gpt-5.4"`, `"claude-sonnet-4-6-20260320"` |
| `provider`      | `string`                                 | Config default   | Provider name for audit labeling |
| `purpose`       | `Purpose`                                | `"text"`         | Purpose routing hint (see [Purpose reference](/sdk/types#purpose) for all 15 supported values) |
| `tier`          | `"efficient" \| "standard" \| "complex"` | *(none)*         | Model capability tier hint |
| `providerAccount` | `string`                               | *(none)*         | Target provider account name |
| `runtime`       | `ProviderRuntimeContract`                | `getDefaultProviderRuntime()` | Provider runtime instance managing credentials and inference adapters |
| `principalId`   | `string`                                 | `"sdk-user"`     | Identity of calling principal, threaded into audit events and capability grants |
| `auditStore`    | `AuditStore`                             | Local file audit store | Injected audit store for recording action lifecycle events |
| `policyStore`   | `PolicyStore`                            | Local file policy store | Injected policy store for grant snapshots and mutations |
| `capabilityLedger` | `CapabilityLedger`                    | Local file capability ledger | Injected ledger for capability lease consumption and revocations |
| `systemPrompt`  | `string`                                 | *(none)*         | Prepended as a system message before the user prompt |
| `tools`         | `(string \| UserToolDefinition \| AnyToolRegistration)[]` | All built-in     | Built-in tool names, group names (`"core"`, `"all"`), or custom registrations (`trustedHostTool`, `preparedTool`, `brokerConnector`) |
| `consentMode`   | `ConsentMode`                            | `"edit-enabled"` | Permission consent mode (`"ask-everything"`, `"edit-enabled"`, `"autonomous"`) |
| `deploymentCeiling` | `CapabilitySet \| Capability[]`      | *(none)*         | Maximum capability lease permitted for any execution |
| `principalPolicy` | `CapabilitySet \| Capability[]`        | *(none)*         | Pre-granted capabilities for the calling principal |
| `approveTool`   | `ApproveToolFn`                          | *(none)*         | Interactive tool approval callback |
| `approvalBroker`| `ApprovalBroker`                         | *(none)*         | Custom approval broker for permission escalation |
| `commitHelper`  | `CommitHelper`                           | Native helper    | Custom or mock exact-commit verifier helper |
| `network`       | `BrokerNetworkAdapter`                   | Standard adapter | Custom broker network adapter with SSRF / IP pinning rules |
| `cwd`           | `string`                                 | `process.cwd()`  | Workspace directory for file tools and skill discovery |
| `skills`        | `string[] \| boolean`                    | `true`           | Skill names to activate, `true` for all discovered, or `false` to opt out of skill injection |
| `maxSteps`      | `number`                                 | `10`             | Maximum agent loop iterations (tool call rounds) |
| `temperature`   | `number`                                 | Provider default | Sampling temperature (0.0 -- 2.0) |
| `maxTokens`     | `number`                                 | Provider default | Maximum tokens in the completion |
| `hooks`         | `Hooks`                                  | *(none)*         | Lifecycle callbacks (beforeToolCall, afterToolCall, onStep, onError, onFinish) |
| `middleware`    | `Middleware[]`                            | *(none)*         | Request/response pipeline functions |
| `metadata`      | `Record<string, unknown>`                 | `{}`             | Adapter-specific metadata passed to middleware |
| `signal`        | `AbortSignal`                            | *(none)*         | Abort controller signal for cancellation (bridged to the agent loop and all media operations in both modes) |
| `config`        | `Record<string, unknown>`                | `{}`             | Extra config passed to tool handlers |

#### Callbacks (both modes)

| Name            | Type         | Description |
|-----------------|--------------|-------------|
| `onText`        | `(delta: string) => void` | Called with each text chunk as it is produced |
| `onToolCall`    | `(tool: { name: string; args: Record<string, unknown>; callId: string }) => void` | Called when the agent invokes a tool |
| `onToolResult`  | `(result: { callId: string; output: string; success: boolean }) => void` | Called when a tool finishes execution |
| `onStep`        | `(step: StepResult) => void` | Called for every agent loop step (text or tool_call) |
| `onError`       | `(error: SeepientError) => void` | Called if an error occurs. Fired in both modes: streaming reports via the callback, non-streaming also rejects with the same typed error |

## Return type (non-streaming)

`Promise<AskSeepientResult>`:

| Field          | Type                                         | Description |
|----------------|----------------------------------------------|-------------|
| `text`         | `string`                                     | The final assistant response text |
| `steps`        | `StepResult[]`                               | Ordered list of all loop iterations (text + tool calls) |
| `toolCalls`    | `ToolCall[]`                                 | All tool calls made during execution |
| `usage`        | `Usage`                                      | Token usage and cost: `{ promptTokens, completionTokens, totalTokens, cost }` |
| `finishReason` | `"stop" \| "max_steps" \| "error" \| "aborted"` | Why the loop terminated |
| `messages`     | `Message[]`                                  | Full conversation history for this invocation |

## Return type (streaming)

`Promise<AskSeepientStreamResult>`:

| Field          | Type                        | Description |
|----------------|-----------------------------|-------------|
| `textStream`   | `AsyncIterable<string>`     | Async iterator yielding text deltas as they arrive |
| `steps`        | `AsyncIterable<StepResult>` | Async iterator yielding each agent loop step |
| `fullText`     | `Promise<string>`           | Resolves with the complete text when the loop finishes |
| `usage`        | `Promise<Usage>`            | Resolves with token usage and cost when the loop finishes |
| `finishReason` | `Promise<string>`           | Resolves with the finish reason (`"stop"`, `"max_steps"`, `"error"`, `"aborted"`) |
| `abort`        | `() => void`                | Call to cancel the running loop (stops the agent loop and any in-flight media operations) |
| `toResponse`   | `(options?: { headers?: Record<string, string> }) => Response` | Returns a Web API `Response` with SSE body, ready for HTTP frameworks |
| `toSSEStream`  | `() => ReadableStream`      | Returns a `ReadableStream` in SSE wire format |

### StepResult

Each step in the agent loop:

```typescript
interface StepResult {
  type: "text" | "tool_call";
  content?: string;                       // Present for type: "text"
  toolCall?: {
    name: string;
    args: Record<string, unknown>;
    result: string;
    duration: number;                     // Milliseconds
  };
  timestamp: number;
}
```

### ToolCall

Record of a tool invocation:

```typescript
interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: string;
}
```

### Usage

Token and cost tracking:

```typescript
interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
}
```

## Examples

### Basic usage

```typescript
const result = await askSeepient("Explain closures in JavaScript");
console.log(result.text);
console.log(`Used ${result.usage.totalTokens} tokens`);
```

### With tools

Use built-in tools by name, or pass group names to include entire categories:

```typescript
// Named tools
const result = await askSeepient("Search for recent news about AI agents", {
  tools: ["web_search"],
});

// Tool groups
const result2 = await askSeepient("Read ./config.json and summarize it", {
  tools: ["core"],  // execute_shell_command, read_file, write_file, get_current_datetime
});
```

### Custom tools

```typescript
import { askSeepient, trustedHostTool } from "seepient";

const dbQuery = trustedHostTool({
  definition: {
    type: "function",
    function: {
      name: "db_query",
      description: "Query the database with a SQL statement",
      parameters: {
        type: "object",
        properties: {
          sql: { type: "string", description: "SQL query to execute" },
        },
        required: ["sql"],
      },
    },
  },
  execute: async (args) => {
    const { sql } = (args ?? {}) as { sql: string };
    const rows = await database.query(sql);
    return JSON.stringify(rows);
  },
});

const result = await askSeepient("How many users signed up last week?", {
  tools: [dbQuery],
});
```

### Multi-step agent loop

The agent automatically chains tool calls across multiple steps:

```typescript
const result = await askSeepient(
  "Find the latest Node.js LTS version and create a file called .nvmrc with just the version number",
  {
    tools: ["web_search", "write_file"],
    maxSteps: 10,
  }
);

// Each step is recorded
for (const step of result.steps) {
  if (step.type === "tool_call") {
    console.log(`Tool: ${step.toolCall.name} -> ${step.toolCall.result.slice(0, 50)}...`);
  }
}
```

### CLI streaming

Pipe agent output to the terminal in real time:

```typescript
const stream = await askSeepient("Explain monads step by step", {
  stream: true,
  provider: "anthropic",
  onText: (delta) => process.stdout.write(delta),
});

const finishReason = await stream.finishReason;
console.log(`\nFinished: ${finishReason}`);
```

### Async iteration

Use `for await...of` to consume the text stream:

```typescript
const stream = await askSeepient("Write a poem about the sea", { stream: true });

for await (const chunk of stream.textStream) {
  process.stdout.write(chunk);
}

const text = await stream.fullText;
```

### Step-by-step observability

Iterate over steps to observe both text generation and tool calls:

```typescript
const stream = await askSeepient("Search for Node.js 22 release notes", {
  stream: true,
  tools: ["web_search"],
});

for await (const step of stream.steps) {
  if (step.type === "text") {
    console.log("[Text]", step.content);
  } else if (step.type === "tool_call") {
    console.log(`[Tool] ${step.toolCall.name}(${JSON.stringify(step.toolCall.args)})`);
    console.log(`  -> ${step.toolCall.result.slice(0, 80)}...`);
  }
}
```

### HTTP SSE with Express

One-liner for server-sent events in any framework that supports the Web API `Response`:

```typescript
import express from "express";
import { askSeepient } from "seepient";

const app = express();

app.get("/stream", async (req, res) => {
  const prompt = req.query.prompt as string;
  const stream = await askSeepient(prompt, { stream: true });
  return stream.toResponse();
});

app.listen(3000);
```

### HTTP SSE with Hono

```typescript
import { Hono } from "hono";
import { askSeepient } from "seepient";

const app = new Hono();

app.get("/stream", async (c) => {
  const prompt = c.req.query("prompt") ?? "Hello";
  const stream = await askSeepient(prompt, { stream: true });
  return stream.toResponse();
});

export default app;
```

::: info
`toResponse()` sets the standard SSE headers (`Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`) automatically. Pass `{ headers }` to add custom headers on top.
:::

### Raw SSE stream

Use `toSSEStream()` when you need the `ReadableStream` directly instead of a full `Response`:

```typescript
const stream = await askSeepient("Generate a story", { stream: true });
const readable = stream.toSSEStream();

// Pipe to a custom WritableStream, transform, etc.
const reader = readable.getReader();
const decoder = new TextDecoder();

while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  console.log(decoder.decode(value));
}
```

The SSE stream emits events in this format:

```
event: text
data: {"delta":"Hello"}

event: tool_call
data: {"callId":"web_search","name":"web_search","args":{"query":"..."}}

event: tool_result
data: {"callId":"web_search","output":"...","success":true}

event: text
data: {"delta":"Here are the results..."}

event: done
data: {"usage":{"totalTokens":470,"cost":0},"finishReason":"stop"}
```

::: info Interleaved ordering (v0.2.2+)
Text deltas and tool events are emitted in their **actual execution order**. Previously, `toSSEStream()` drained all text deltas first, then all tool events — even when tools ran between text chunks. As of v0.2.2, the event queue preserves the real interleaved order, so consumers see text and tool events in the sequence they actually occurred.
:::

### Abort mid-execution

Cancel a running stream from the caller side:

```typescript
const stream = await askSeepient("Analyze this huge document...", {
  stream: true,
  tools: ["read_file"],
});

// Abort after 3 seconds
setTimeout(() => stream.abort(), 3000);

const finishReason = await stream.finishReason;
console.log(`Ended: ${finishReason}`); // "aborted"
```

Or cancel via `AbortSignal` (works in both modes):

```typescript
const controller = new AbortController();

// Abort after 5 seconds
setTimeout(() => controller.abort(), 5000);

const result = await askSeepient("Analyze this large dataset...", {
  signal: controller.signal,
});

// result.finishReason will be "aborted"
```

::: info
The abort signal propagates to the underlying provider SDK (OpenAI, Anthropic, etc.), cancelling the in-flight HTTP request at the network level rather than only checking between agent loop steps. It also reaches media operations (`generate_image` and other vendor media fetches), so aborted calls stop consuming network and billing resources.
:::

### Combined callbacks and async iteration

Use both callbacks for immediate side effects and async iteration for downstream processing:

```typescript
const stream = await askSeepient("Research AI agent frameworks", {
  stream: true,
  tools: ["web_search"],
  onToolCall: ({ name }) => console.log(`[Calling ${name}]`),
  onToolResult: ({ output, success }) => {
    if (!success) console.error("Tool failed:", output);
  },
});

// Still consume the text stream for downstream use
const chunks: string[] = [];
for await (const chunk of stream.textStream) {
  chunks.push(chunk);
}
```

### Hooks

Lifecycle callbacks for observability and side effects (fire in both modes; `onFinish` receives the assembled result in streaming mode too):

```typescript
const result = await askSeepient("Deploy the staging environment", {
  tools: ["execute_shell_command"],
  hooks: {
    beforeToolCall: ({ name, args }) => {
      console.log(`About to call ${name} with`, args);
    },
    afterToolCall: ({ name, output, duration }) => {
      console.log(`${name} took ${duration}ms: ${output.slice(0, 100)}`);
    },
    onStep: (step) => {
      metrics.increment("agent.step");
    },
    onError: (error) => {
      logger.error({ err: error }, "Agent error");
    },
    onFinish: (result) => {
      logger.info({ tokens: result.usage.totalTokens }, "Agent finished");
    },
  },
});
```

## Hooks interface

```typescript
interface Hooks {
  beforeToolCall?: (call: {
    name: string;
    args: Record<string, unknown>;
  }) => void | Promise<void>;

  afterToolCall?: (result: {
    name: string;
    output: string;
    duration: number;
  }) => void | Promise<void>;

  onStep?: (step: StepResult) => void | Promise<void>;

  onError?: (error: SeepientError) => void | Promise<void>;

  onFinish?: (result: AskSeepientResult) => void | Promise<void>;
}
```

## Error handling

Seepient Agent throws typed errors that all extend `SeepientError`:

| Error class     | Code              | `retryable` | When                                      |
| --------------- | ----------------- | ------------ | ----------------------------------------- |
| `ProviderError` | `PROVIDER_ERROR`  | `true`       | LLM API call failure, auth, rate-limit    |
| `ToolError`     | `TOOL_FAILED`     | `true`       | Tool execution failure                    |
| `MaxStepsError` | `MAX_STEPS`       | `false`      | Agent loop exceeded `maxSteps`            |
| `AbortedError`  | `ABORTED`         | `false`      | Operation cancelled via `AbortSignal`     |

```typescript
import { ProviderError, AbortedError } from "seepient";

try {
  const result = await askSeepient("Hello", { provider: "anthropic" });
} catch (err) {
  if (err instanceof ProviderError) {
    console.log(`Provider failed: ${err.message} (retryable: ${err.retryable})`);
  }
}
```

::: tip
A failed streaming turn is always observable: `fullText` **rejects** with the typed `SeepientError` (parity with the non-streaming throw), `finishReason` resolves `"error"`, and `onError` fires in both modes. `textStream` still completes cleanly for consumers that only iterate deltas.
:::

## Related APIs

- [createSeepient()](/sdk/create-seepient) -- Stateful multi-turn agent
- [Tools](/tools/reference) -- Built-in and custom tool reference
