---
title: streamText()
description: Streaming agent execution with async iterables, real-time callbacks, and HTTP SSE helpers.
---

# streamText()

Run a one-shot agent loop with streaming callbacks. Returns `AsyncIterable`s for text and steps, plus `toResponse()` and `toSSEStream()` for HTTP server integration.

## Signature

```typescript
function streamText(
  prompt: string,
  options?: StreamTextOptions,
): Promise<StreamTextResult>
```

## Quick example

```typescript
import { streamText } from "seepient";

const stream = await streamText("Explain quantum computing simply", {
  onText: (delta) => process.stdout.write(delta),
});

const finalText = await stream.fullText;
console.log(`\nDone. ${(await stream.usage).totalTokens} tokens used.`);
```

## Parameters

### `prompt` (required)

| Type     | Description                 |
| -------- | --------------------------- |
| `string` | The user message to process |

### `options` (optional)

`StreamTextOptions` extends `GenerateTextOptions` with streaming callbacks. All fields are optional.

#### Inherited from GenerateTextOptions

| Name            | Type                                     | Default | Description |
|-----------------|------------------------------------------|---------|-------------|
| `model`         | `string`                                 | Provider default | Model identifier |
| `provider`      | `ProviderType`                           | Config default   | Provider to use |
| `systemPrompt`  | `string`                                 | *(none)*         | System message prepended to the conversation |
| `tools`         | `string[] \| UserToolDefinition[]`       | All built-in     | Tools available to the agent |
| `skills`        | `string[]`                               | *(none)*         | Skills to activate |
| `maxSteps`      | `number`                                 | `10`             | Maximum agent loop iterations |
| `temperature`   | `number`                                 | Provider default | Sampling temperature |
| `maxTokens`     | `number`                                 | Provider default | Maximum completion tokens |
| `output`        | `unknown`                                | *(none)*         | Zod schema for structured output |
| `hooks`         | `Hooks`                                  | *(none)*         | Lifecycle callbacks |
| `signal`        | `AbortSignal`                            | *(none)*         | Abort signal |
| `config`        | `Record<string, unknown>`                | `{}`             | Extra config for tool handlers |

#### Stream-specific callbacks

| Name            | Type         | Description |
|-----------------|--------------|-------------|
| `onText`        | `(delta: string) => void` | Called with each text chunk as it is produced |
| `onToolCall`    | `(tool: { name: string; args: Record<string, unknown>; callId: string }) => void` | Called when the agent invokes a tool |
| `onToolResult`  | `(result: { callId: string; output: string; success: boolean }) => void` | Called when a tool finishes execution |
| `onStep`        | `(step: StepResult) => void` | Called for every agent loop step (text or tool_call) |
| `onError`       | `(error: SeepientError) => void` | Called if an error occurs during execution |

## Return type

`Promise<StreamTextResult>`:

| Field          | Type                        | Description |
|----------------|-----------------------------|-------------|
| `textStream`   | `AsyncIterable<string>`     | Async iterator yielding text deltas as they arrive |
| `steps`        | `AsyncIterable<StepResult>` | Async iterator yielding each agent loop step |
| `fullText`     | `Promise<string>`           | Resolves with the complete text when the loop finishes |
| `usage`        | `Promise<Usage>`            | Resolves with token usage and cost when the loop finishes |
| `finishReason` | `Promise<string>`           | Resolves with the finish reason (`"stop"`, `"max_steps"`, `"error"`, `"aborted"`) |
| `abort`        | `() => void`                | Call to cancel the running loop |
| `toResponse`   | `() => Response`            | Returns a Web API `Response` with SSE body, ready for HTTP frameworks |
| `toSSEStream`  | `() => ReadableStream`      | Returns a `ReadableStream` in SSE wire format |

## Examples

### CLI streaming

Pipe agent output to the terminal in real time:

```typescript
import { streamText } from "seepient";

const stream = await streamText("Explain monads step by step", {
  provider: "anthropic",
  onText: (delta) => process.stdout.write(delta),
});

const finishReason = await stream.finishReason;
console.log(`\nFinished: ${finishReason}`);
```

### Async iteration

Use `for await...of` to consume the text stream:

```typescript
const stream = await streamText("Write a poem about the sea");

for await (const chunk of stream.textStream) {
  process.stdout.write(chunk);
}

const text = await stream.fullText;
```

### Step-by-step observability

Iterate over steps to observe both text generation and tool calls:

```typescript
const stream = await streamText("Search for Node.js 22 release notes", {
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
import { streamText } from "seepient";

const app = express();

app.get("/stream", async (req, res) => {
  const prompt = req.query.prompt as string;
  const stream = await streamText(prompt);
  return stream.toResponse();
});

app.listen(3000);
```

### HTTP SSE with Hono

```typescript
import { Hono } from "hono";
import { streamText } from "seepient";

const app = new Hono();

app.get("/stream", async (c) => {
  const prompt = c.req.query("prompt") ?? "Hello";
  const stream = await streamText(prompt);
  return stream.toResponse();
});

export default app;
```

::: info
`toResponse()` sets the standard SSE headers (`Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`) automatically.

::: tip Interleaved events
As of v0.2.2, the SSE stream emits tool events inline with text deltas in their real execution order, rather than all text first followed by all tool events. This matches what the `textStream` and `steps` async iterables produce when consumed together.
:::
:::

### Raw SSE stream

Use `toSSEStream()` when you need the `ReadableStream` directly instead of a full `Response`:

```typescript
const stream = await streamText("Generate a story");
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
const stream = await streamText("Analyze this huge document...", {
  tools: ["read_file"],
});

// Abort after 3 seconds
setTimeout(() => stream.abort(), 3000);

const finishReason = await stream.finishReason;
console.log(`Ended: ${finishReason}`); // "aborted"
```

::: info
The `AbortSignal` propagates to the underlying provider SDK (OpenAI, Anthropic, etc.), cancelling the in-flight HTTP request at the network level rather than only checking between agent loop steps. This means network resources are released immediately on abort.
:::

### Combined callbacks and async iteration

Use both callbacks for immediate side effects and async iteration for downstream processing:

```typescript
const stream = await streamText("Research AI agent frameworks", {
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

## Related APIs

- [generateText()](/sdk/generate-text) -- Non-streaming one-shot execution
- [createAgent()](/sdk/create-agent) -- Stateful agent with `.chatStream()` method
