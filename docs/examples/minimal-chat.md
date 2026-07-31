---
title: Minimal Chat Example
description: The simplest possible Seepient Agent chat examples with one-shot, streaming, and tool-using variants.
---

# Minimal Chat Example

The simplest way to use Seepient Agent. Each variant shows a different mode of operation.

## Prerequisites

```bash
npm install seepient
```

Set at least one provider API key:

```bash
export OPENAI_API_KEY=sk-...
```

## One-Shot Generation

The most basic usage: send a prompt, get a response.

```typescript
import { generateText } from "seepient";

const { text } = await generateText("Hello, what can you do?");
console.log(text);
```

## Streaming

Stream text as it is generated using async iterables:

```typescript
import { streamText } from "seepient";

const stream = await streamText("Explain quantum computing in simple terms", {
  onText: (delta) => process.stdout.write(delta),
});

const finalText = await stream.fullText;
console.log("\n--- Done ---");
console.log(`Tokens: ${(await stream.usage).totalTokens}`);
```

## With Tools

Enable built-in tools by name:

```typescript
import { generateText } from "seepient";

const result = await generateText(
  "What files are in the current directory?",
  {
    tools: ["execute_shell_command"],
    maxSteps: 5,
  }
);

console.log(result.text);

// See which tools were called
for (const call of result.toolCalls) {
  console.log(`Tool: ${call.name}`);
  console.log(`Args: ${JSON.stringify(call.arguments)}`);
  console.log(`Result: ${call.result?.slice(0, 100)}`);
}
```

## Multiple Tool Groups

Use group names to include entire categories:

```typescript
import { generateText } from "seepient";

const result = await generateText(
  "Search for the latest TypeScript release and email a summary to dev@team.com",
  {
    tools: ["comm", "core"],  // comm = email + search + notifications
    maxSteps: 10,
  }
);

console.log(result.text);
console.log(`Cost: $${result.usage.cost.toFixed(4)}`);
```

## With a Custom Tool

Define and use a custom tool inline:

```typescript
import { generateText, tool } from "seepient";
import { z } from "zod";

const diceTool = tool({
  name: "roll_dice",
  description: "Roll a dice with a specified number of sides",
  parameters: z.object({
    sides: z.number().describe("Number of sides on the dice"),
  }),
  execute: async ({ sides }) => {
    const result = Math.floor(Math.random() * sides) + 1;
    return `Rolled a ${sides}-sided dice: ${result}`;
  },
});

const result = await generateText("Roll a 20-sided dice for me", {
  tools: [diceTool],
});

console.log(result.text);
```

## Error Handling

Handle provider errors and tool failures gracefully:

```typescript
import { generateText } from "seepient";

try {
  const result = await generateText("Analyze this dataset", {
    tools: ["core"],
    maxSteps: 5,
  });

  if (result.finishReason === "error") {
    console.error("Generation failed");
  } else {
    console.log(result.text);
  }
} catch (error) {
  console.error("Fatal error:", error.message);
}
```

## Abort Support

Cancel a long-running generation:

```typescript
import { generateText } from "seepient";

const controller = new AbortController();

// Cancel after 10 seconds
setTimeout(() => {
  controller.abort();
  console.log("Aborted!");
}, 10_000);

const result = await generateText("Write a detailed essay on AI safety", {
  tools: ["core"],
  signal: controller.signal,
});
```
