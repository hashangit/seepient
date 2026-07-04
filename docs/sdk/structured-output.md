---
title: Structured Output
description: Get typed, validated responses from LLMs using Zod schemas with generateText() and streamText().
---

# Structured Output

Seepient Agent supports Zod-based structured output. Pass a Zod schema to the `output` option and receive a fully typed, validated result instead of raw text.

## Quick example

```typescript
import { generateText } from "seepient";
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

## How it works

1. You pass a Zod schema as the `output` option to `generateText()` or `streamText()`.
2. Seepient Agent instructs the LLM to produce JSON that conforms to the schema.
3. The raw JSON is parsed and validated against the schema.
4. If validation succeeds, the typed data is available on `result.data`.
5. If validation fails, error details are available on `result.error`.

## Result shape

When `output` is provided, `GenerateTextResult` includes these fields:

| Field    | Type                                   | Description |
|----------|----------------------------------------|-------------|
| `data`   | `unknown`                              | Validated structured data. Present when validation succeeds. |
| `error`  | `{ message: string; issues: unknown }` | Validation error details. Present when validation fails. |
| `text`   | `string`                               | The raw LLM response text (the JSON string before parsing) |

```typescript
interface GenerateTextResult {
  text: string;
  data?: unknown;
  error?: { message: string; issues: unknown };
  steps: StepResult[];
  toolCalls: ToolCall[];
  usage: Usage;
  finishReason: "stop" | "length" | "max_steps" | "error";
  messages: Message[];
}
```

::: tip
When validation succeeds, `data` is present and `error` is `undefined`. When validation fails, `error` is present and `data` is `undefined`. Both are never present at the same time.
:::

## Complex schemas

Zod's full power is available -- nested objects, arrays, enums, unions, optional fields, and transforms:

```typescript
import { generateText } from "seepient";
import { z } from "zod";

const BugReport = z.object({
  title: z.string().describe("Short summary of the bug"),
  severity: z.enum(["critical", "high", "medium", "low"]),
  description: z.string().describe("Detailed description of the issue"),
  stepsToReproduce: z.array(z.string()).describe("Ordered steps to trigger the bug"),
  environment: z.object({
    os: z.string(),
    browser: z.string().optional(),
    version: z.string(),
  }),
  tags: z.array(z.string()),
  assignee: z.string().optional(),
});

const result = await generateText(
  "Analyze this error log and create a bug report:\n" +
  "TypeError: Cannot read property 'map' of undefined at UserList.tsx:42",
  { output: BugReport },
);

if (result.data) {
  console.log(`[${result.data.severity}] ${result.data.title}`);
  console.log(`Steps: ${result.data.stepsToReproduce.join(" -> ")}`);
  console.log(`Tags: ${result.data.tags.join(", ")}`);
}
```

::: tip
Use `.describe()` on schema fields. The descriptions are sent to the LLM and help it produce output that matches your expectations.
:::

## Error handling

When the LLM output fails validation, check `result.error` for details:

```typescript
import { generateText } from "seepient";
import { z } from "zod";

const StrictSchema = z.object({
  id: z.string().uuid(),
  score: z.number().min(0).max(100),
  category: z.enum(["a", "b", "c"]),
});

const result = await generateText("Rate this item", {
  output: StrictSchema,
});

if (result.error) {
  console.error("Validation failed:", result.error.message);
  // Zod issues contain detailed path and message info
  console.error("Issues:", result.error.issues);
} else {
  console.log("Parsed data:", result.data);
}
```

### Common validation failures

| Cause               | What happens                                              |
|---------------------|-----------------------------------------------------------|
| Invalid JSON        | `error.message` contains the JSON parse error             |
| Schema mismatch     | `error.issues` contains Zod validation issues with paths  |
| Missing fields      | `error.issues` lists each missing required field          |
| Wrong enum value    | `error.issues` shows the invalid value and valid options  |

### Retry on validation failure

```typescript
async function generateWithRetry(
  prompt: string,
  schema: z.ZodSchema,
  maxRetries = 2,
): Promise<unknown> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await generateText(prompt, { output: schema });

    if (result.data) {
      return result.data;
    }

    if (attempt < maxRetries) {
      // Include the error details in the retry prompt
      prompt += `\n\nPrevious attempt failed validation: ${result.error?.message}. ` +
                `Please ensure the output matches the schema exactly.`;
    }
  }

  throw new Error("Structured output validation failed after retries");
}
```

## Integration with tools

Structured output works alongside tools. The agent executes tools as needed, then produces structured output as the final response:

```typescript
import { generateText } from "seepient";
import { z } from "zod";

const AnalysisResult = z.object({
  summary: z.string(),
  fileCount: z.number(),
  languages: z.array(z.string()),
  issues: z.array(z.object({
    file: z.string(),
    description: z.string(),
    severity: z.enum(["warning", "error"]),
  })),
});

const result = await generateText("Analyze the codebase structure and find issues", {
  tools: ["read_file", "execute_shell_command"],
  maxSteps: 10,
  output: AnalysisResult,
});

if (result.data) {
  console.log(`Found ${result.data.fileCount} files`);
  console.log(`Languages: ${result.data.languages.join(", ")}`);
  for (const issue of result.data.issues) {
    console.log(`[${issue.severity}] ${issue.file}: ${issue.description}`);
  }
}
```

::: warning
When using tools with structured output, the LLM must produce valid JSON as its final response after all tool calls complete. Ensure `maxSteps` is high enough for the agent to finish its tool use before generating structured output.
:::

## Streaming with structured output

Structured output with `streamText()` validates the final result. During streaming, text deltas contain the raw JSON being generated:

```typescript
import { streamText } from "seepient";
import { z } from "zod";

const Summary = z.object({
  keyPoints: z.array(z.string()),
  sentiment: z.enum(["positive", "negative", "neutral"]),
  wordCount: z.number(),
});

const stream = await streamText("Summarize this article: ...", {
  output: Summary,
  onText: (delta) => process.stdout.write(delta),
});

const finalText = await stream.fullText;

// Parse the final text yourself, or use generateText() for automatic validation
const parsed = Summary.safeParse(JSON.parse(finalText));
if (parsed.success) {
  console.log(parsed.data);
}
```

::: info
For structured output, `generateText()` is usually the better choice since it handles parsing and validation automatically. Use `streamText()` with structured output only when you need real-time streaming feedback during generation.
:::

## Schema tips

### Use `.describe()` liberally

```typescript
const schema = z.object({
  // Good: gives the LLM context
  priority: z.number().min(1).max(5).describe("1 = lowest, 5 = highest"),

  // Bad: the LLM has no guidance
  priority: z.number().min(1).max(5),
});
```

### Prefer enums over free-form strings

```typescript
// Good: constrained choices
status: z.enum(["open", "in_progress", "resolved", "closed"]),

// Risky: the LLM may produce unexpected values
status: z.string(),
```

### Use optional fields for uncertain data

```typescript
const schema = z.object({
  title: z.string(),                  // Always required
  assignee: z.string().optional(),    // LLM may omit if unknown
  dueDate: z.string().optional(),     // LLM may omit if not mentioned
});
```

## Related APIs

- [generateText()](/sdk/generate-text) -- One-shot execution with `output` option
- [streamText()](/sdk/stream-text) -- Streaming execution with structured output
- [Types](/sdk/types) -- Full TypeScript type reference
