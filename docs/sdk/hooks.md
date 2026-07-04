---
title: Hooks
description: Lifecycle hooks for observability, logging, analytics, and side effects during agent execution.
---

# Hooks

Hooks are lifecycle callbacks that fire at key points during agent execution. Use them for logging, analytics, cost tracking, error alerting, or any side effect -- without modifying the core agent loop.

## Hooks interface

```typescript
interface Hooks {
  /** Called before each tool execution. */
  beforeToolCall?: (
    call: { name: string; args: Record<string, unknown> },
  ) => void | Promise<void>;

  /** Called after each tool execution completes. */
  afterToolCall?: (
    result: { name: string; output: string; duration: number },
  ) => void | Promise<void>;

  /** Called for every step in the agent loop (text or tool_call). */
  onStep?: (step: StepResult) => void | Promise<void>;

  /** Called when an error occurs. */
  onError?: (error: SeepientError) => void | Promise<void>;

  /** Called when the agent loop finishes. */
  onFinish?: (result: GenerateTextResult) => void | Promise<void>;
}
```

## Quick example

```typescript
import { generateText } from "seepient";

const result = await generateText("Deploy the staging environment", {
  tools: ["execute_shell_command"],
  hooks: {
    beforeToolCall: ({ name, args }) => {
      console.log(`[hook] Calling ${name}`, args);
    },
    afterToolCall: ({ name, output, duration }) => {
      console.log(`[hook] ${name} finished in ${duration}ms`);
    },
    onFinish: (result) => {
      console.log(`[hook] Done. ${result.usage.totalTokens} tokens used.`);
    },
  },
});
```

::: info Safety guarantee
Hook errors are caught and logged internally. A failing hook will never crash the agent loop.
:::

## Hook lifecycle

The agent loop triggers hooks in this order:

```
1. [per step]   onStep(step)             -- text or tool_call
2. [if tool]    beforeToolCall(call)     -- about to execute a tool
3. [if tool]    afterToolCall(result)    -- tool finished
4. [on error]   onError(error)           -- something went wrong
5. [always]     onFinish(result)         -- loop terminated
```

## Using hooks with createAgent

Hooks work identically with `createAgent()`. They fire on every `chat()` and `chatStream()` call:

```typescript
import { createAgent } from "seepient";

const agent = await createAgent({
  tools: ["core", "web_search"],
  hooks: {
    beforeToolCall: ({ name, args }) => {
      auditLog.record({ event: "tool_call", name, args, timestamp: Date.now() });
    },
    afterToolCall: ({ name, duration }) => {
      metrics.timing("tool.duration", duration, { tool: name });
    },
    onError: (error) => {
      alerting.notify(`Seepient Agent error: ${error.code} - ${error.message}`);
    },
  },
});
```

## Examples

### Logging hooks

```typescript
const result = await generateText("Analyze the codebase", {
  tools: ["core"],
  hooks: {
    beforeToolCall: ({ name, args }) => {
      logger.info("tool.call", { name, args: JSON.stringify(args) });
    },
    afterToolCall: ({ name, output, duration }) => {
      logger.info("tool.result", {
        name,
        duration,
        outputLength: output.length,
      });
    },
    onStep: (step) => {
      logger.info("agent.step", {
        type: step.type,
        timestamp: step.timestamp,
      });
    },
    onError: (error) => {
      logger.error("agent.error", {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
      });
    },
    onFinish: (result) => {
      logger.info("agent.finish", {
        finishReason: result.finishReason,
        steps: result.steps.length,
        tokens: result.usage.totalTokens,
      });
    },
  },
});
```

### Analytics tracking

```typescript
import { generateText } from "seepient";
import { analytics } from "./analytics.js";

const result = await generateText("Search for AI news", {
  tools: ["web_search"],
  hooks: {
    beforeToolCall: ({ name }) => {
      analytics.track("tool_invoked", { tool: name });
    },
    afterToolCall: ({ name, duration }) => {
      analytics.track("tool_completed", {
        tool: name,
        duration_ms: duration,
      });
    },
    onFinish: (result) => {
      analytics.track("agent_completed", {
        steps: result.steps.length,
        tool_calls: result.toolCalls.length,
        tokens: result.usage.totalTokens,
        finish_reason: result.finishReason,
      });
    },
  },
});
```

### Cost tracking

```typescript
import { generateText } from "seepient";

const costs: { prompt: number; completion: number; total: number }[] = [];

const result = await generateText("Complex analysis task", {
  tools: ["all"],
  hooks: {
    onFinish: (result) => {
      costs.push({
        prompt: result.usage.promptTokens,
        completion: result.usage.completionTokens,
        total: result.usage.totalTokens,
      });
    },
  },
});

const totalTokens = costs.reduce((sum, c) => sum + c.total, 0);
console.log(`Total tokens used: ${totalTokens}`);
```

### Error alerting

```typescript
import { generateText, ProviderError, ToolError } from "seepient";
import { sendAlert } from "./ops.js";

const result = await generateText("Run the migration", {
  tools: ["execute_shell_command"],
  hooks: {
    onError: (error) => {
      // Only alert on non-retryable errors
      if (!error.retryable) {
        // Access subclass-specific properties via type narrowing
        const provider = error instanceof ProviderError ? error.provider : undefined;
        const tool = error instanceof ToolError ? error.tool : undefined;
        sendAlert({
          level: "critical",
          title: `Seepient Agent ${error.code}`,
          message: error.message,
          provider,
          tool,
        });
      }
    },
    afterToolCall: ({ name, output, duration }) => {
      // Alert on slow tool calls
      if (duration > 30_000) {
        sendAlert({
          level: "warning",
          title: `Slow tool: ${name}`,
          message: `${name} took ${duration}ms`,
        });
      }
    },
  },
});
```

### WebSocket relay

Stream agent events to connected WebSocket clients in real time:

```typescript
import { generateText } from "seepient";
import type { WebSocket } from "ws";

function relayToClient(ws: WebSocket) {
  return {
    beforeToolCall: ({ name, args }: { name: string; args: Record<string, unknown> }) => {
      ws.send(JSON.stringify({ event: "tool_start", name, args }));
    },
    afterToolCall: ({ name, output, duration }: { name: string; output: string; duration: number }) => {
      ws.send(JSON.stringify({ event: "tool_end", name, output, duration }));
    },
    onStep: (step: StepResult) => {
      ws.send(JSON.stringify({ event: "step", step }));
    },
    onFinish: (result: GenerateTextResult) => {
      ws.send(JSON.stringify({
        event: "done",
        tokens: result.usage.totalTokens,
        finishReason: result.finishReason,
      }));
    },
  };
}

// Usage with a WebSocket connection
ws.on("connection", (socket) => {
  socket.on("message", async (data) => {
    const prompt = data.toString();
    await generateText(prompt, {
      tools: ["core"],
      hooks: relayToClient(socket),
    });
  });
});
```

## Related APIs

- [generateText()](/sdk/generate-text) -- One-shot execution with hooks
- [streamText()](/sdk/stream-text) -- Streaming with `onText`, `onToolCall`, `onToolResult` callbacks
- [createAgent()](/sdk/create-agent) -- Stateful agent with persistent hooks
- [Types](/sdk/types) -- Full TypeScript type reference
