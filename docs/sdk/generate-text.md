---
title: generateText()
description: One-shot agent execution -- send a prompt, get a structured result with automatic tool calls, hooks, and structured output.
---

# generateText()

Run a one-shot agent loop and return the structured result. Creates fresh state for each call (stateless). Handles tool calls automatically until the provider returns no more tool calls or `maxSteps` is reached.

## Signature

```typescript
function generateText(
  prompt: string,
  options?: GenerateTextOptions,
): Promise<GenerateTextResult>
```

## Quick example

```typescript
import { generateText } from "seepient";

const result = await generateText("What is the weather in San Francisco?", {
  tools: ["web_search"],
  maxSteps: 5,
});

console.log(result.text);
// => "The current weather in San Francisco is 65F with light fog..."

console.log(result.toolCalls.length);
// => 1  (the web_search call)

console.log(result.usage);
// => { promptTokens: 342, completionTokens: 128, totalTokens: 470, cost: 0 }
```

## Parameters

### `prompt` (required)

| Type     | Description                 |
| -------- | --------------------------- |
| `string` | The user message to process |

### `options` (optional)

`GenerateTextOptions` -- all fields optional:

| Name            | Type                                     | Default | Description |
|-----------------|------------------------------------------|---------|-------------|
| `model`         | `string`                                 | Provider default | Model identifier, e.g. `"gpt-5.4"`, `"claude-sonnet-4-6-20260320"` |
| `provider`      | `ProviderType`                           | Config default   | `"openai"` \| `"anthropic"` \| `"glm"` \| `"openai-compatible"` |
| `systemPrompt`  | `string`                                 | *(none)*         | Prepended as a system message before the user prompt |
| `tools`         | `string[] \| UserToolDefinition[]`       | All built-in     | Built-in tool names, group names (`"core"`, `"all"`), or custom tool definitions |
| `skills`        | `string[]`                               | *(none)*         | Skill names to activate for this invocation |
| `maxSteps`      | `number`                                 | `10`             | Maximum agent loop iterations (tool call rounds) |
| `temperature`   | `number`                                 | Provider default | Sampling temperature (0.0 -- 2.0) |
| `maxTokens`     | `number`                                 | Provider default | Maximum tokens in the completion |
| `output`        | `unknown`                                | *(none)*         | Zod schema for structured/typed response |
| `hooks`         | `Hooks`                                  | *(none)*         | Lifecycle callbacks (beforeToolCall, afterToolCall, onStep, onError, onFinish) |
| `signal`        | `AbortSignal`                            | *(none)*         | Abort controller signal for cancellation |
| `config`        | `Record<string, unknown>`                | `{}`             | Extra config passed to tool handlers |

## Return type

`Promise<GenerateTextResult>`:

| Field          | Type                                         | Description |
|----------------|----------------------------------------------|-------------|
| `text`         | `string`                                     | The final assistant response text |
| `data`         | `unknown`                                    | Structured data when `output` schema is provided |
| `error`        | `{ message: string; issues: unknown }`       | Present if structured output parsing failed |
| `steps`        | `StepResult[]`                               | Ordered list of all loop iterations (text + tool calls) |
| `toolCalls`    | `ToolCall[]`                                 | All tool calls made during execution |
| `usage`        | `Usage`                                      | Token usage and cost: `{ promptTokens, completionTokens, totalTokens, cost }` |
| `finishReason` | `"stop" \| "max_steps" \| "error" \| "aborted"` | Why the loop terminated. Note: `"length"` is in the type but never produced at runtime |
| `messages`     | `Message[]`                                  | Full conversation history for this invocation |

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
const result = await generateText("Explain closures in JavaScript");
console.log(result.text);
console.log(`Used ${result.usage.totalTokens} tokens`);
```

### With tools

Use built-in tools by name, or pass group names to include entire categories:

```typescript
// Named tools
const result = await generateText("Search for recent news about AI agents", {
  tools: ["web_search"],
});

// Tool groups
const result2 = await generateText("Read ./config.json and summarize it", {
  tools: ["core"],  // execute_shell_command, read_file, write_file, get_current_datetime
});
```

### Custom tools

```typescript
import { generateText, tool } from "seepient";
import { z } from "zod";

const dbQuery = tool({
  name: "db_query",
  description: "Query the database with a SQL statement",
  parameters: z.object({
    sql: z.string().describe("SQL query to execute"),
  }),
  execute: async ({ sql }) => {
    const rows = await database.query(sql);
    return JSON.stringify(rows);
  },
});

const result = await generateText("How many users signed up last week?", {
  tools: [dbQuery],
});
```

### Structured output

Pass a Zod schema to `output` for typed responses:

```typescript
import { z } from "zod";

const Sentiment = z.object({
  label: z.enum(["positive", "negative", "neutral"]),
  confidence: z.number().min(0).max(1),
});

const result = await generateText("Analyze: 'This product is amazing!'", {
  output: Sentiment,
});

if (result.data) {
  console.log(result.data.label);      // "positive"
  console.log(result.data.confidence);  // 0.95
}
```

### Multi-step agent loop

The agent automatically chains tool calls across multiple steps:

```typescript
const result = await generateText(
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

### Abort mid-execution

```typescript
const controller = new AbortController();

// Abort after 5 seconds
setTimeout(() => controller.abort(), 5000);

const result = await generateText("Analyze this large dataset...", {
  signal: controller.signal,
});

// result.finishReason will be "error" if aborted
```

### Hooks

Lifecycle callbacks for observability and side effects:

```typescript
const result = await generateText("Deploy the staging environment", {
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

  onFinish?: (result: GenerateTextResult) => void | Promise<void>;
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
  const result = await generateText("Hello", { provider: "anthropic" });
} catch (err) {
  if (err instanceof ProviderError) {
    console.log(`Provider failed: ${err.message} (retryable: ${err.retryable})`);
  }
}
```

::: tip
When `finishReason` is `"error"`, the loop still returns a partial result rather than throwing. Check `result.finishReason` and `result.steps` to inspect what happened before the error.
:::

## Related APIs

- [streamText()](/sdk/stream-text) -- Streaming variant with async iterables
- [createAgent()](/sdk/create-agent) -- Stateful multi-turn agent
- [Tools](/tools/reference) -- Built-in and custom tool reference
