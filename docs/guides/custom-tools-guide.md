---
title: Custom Tools Guide
description: Create, register, and use custom tools with Seepient Agent's tool framework.
---

# Custom Tools Guide

Tools are the building blocks that give Seepient Agent agents the ability to take action. This guide covers creating custom tools using the `tool()` factory, registering them, and mixing them with built-in tools.

## What Are Tools?

A tool is a function that an LLM can invoke during generation. Each tool has:

- A **name** and **description** that tell the LLM when to use it
- A **parameter schema** (Zod or JSON Schema) that defines the inputs
- An **execute function** that runs when the LLM calls the tool

Seepient Agent ships with 12 built-in tools (see [Tools Reference](/tools/reference)). Custom tools use the same interface, so they work identically in `generateText`, `streamText`, and `createAgent`.

## Step 1: Define a Tool with Zod Schema

Use the `tool()` factory to create a tool from a Zod schema:

```typescript
import { tool } from "seepient";
import { z } from "zod";

const weatherTool = tool({
  name: "get_weather",
  description: "Get the current weather for a given city",
  parameters: z.object({
    city: z.string().describe("The city name, e.g. 'Tokyo'"),
    units: z
      .enum(["celsius", "fahrenheit"])
      .optional()
      .describe("Temperature units"),
  }),
  execute: async ({ city, units }) => {
    const unitParam = units === "fahrenheit" ? "imperial" : "metric";
    const response = await fetch(
      `https://api.openweathermap.org/data/2.5/weather?q=${city}&units=${unitParam}&appid=${process.env.OPENWEATHER_KEY}`
    );
    const data = await response.json();
    return `${data.name}: ${data.main.temp}°${units === "fahrenheit" ? "F" : "C"}, ${data.weather[0].description}`;
  },
});
```

The Zod schema is automatically converted to JSON Schema for the LLM. Field descriptions from `.describe()` are included in the tool definition sent to the provider.

### Without Zod

You can also pass a plain JSON Schema object:

```typescript
const calculatorTool = tool({
  name: "calculate",
  description: "Evaluate a mathematical expression",
  parameters: {
    type: "object",
    properties: {
      expression: {
        type: "string",
        description: "Math expression, e.g. '2 + 3 * 4'",
      },
    },
    required: ["expression"],
  },
  execute: async ({ expression }) => {
    // Simple safe eval for demo purposes
    const result = Function(`"use strict"; return (${expression})`)();
    return `${expression} = ${result}`;
  },
});
```

## Step 2: Implement the Execute Function

The execute function receives validated arguments and an optional context object:

```typescript
interface ToolContext {
  onUpdate?: (progress: { percentage: number; message?: string }) => void;
  signal?: AbortSignal;
  config?: Record<string, unknown>;
}

execute: async (args: Args, context: ToolContext) => string | ToolResult
```

### Return Types

The execute function can return:

- A **string** -- the output text sent back to the LLM
- A **ToolResult** object with structured metadata:

```typescript
interface ToolResult {
  output: string;
  success: boolean;
  metadata?: Record<string, unknown>;
}
```

Example with structured result:

```typescript
execute: async ({ query }) => {
  const results = await searchDatabase(query);

  return {
    output: `Found ${results.length} results`,
    success: true,
    metadata: { resultCount: results.length, queryTime: 120 },
  };
},
```

## Step 3: Add Progress Reporting

For long-running operations, use `context.onUpdate` to report progress:

```typescript
const batchProcessor = tool({
  name: "process_batch",
  description: "Process a batch of files",
  parameters: z.object({
    directory: z.string(),
    pattern: z.string(),
  }),
  execute: async ({ directory, pattern }, context) => {
    const files = await glob(pattern, { cwd: directory });
    const total = files.length;
    const results = [];

    for (let i = 0; i < files.length; i++) {
      // Check for abort
      if (context.signal?.aborted) {
        return "Processing aborted by user";
      }

      // Report progress
      context.onUpdate?.({
        percentage: Math.round(((i + 1) / total) * 100),
        message: `Processing ${files[i]} (${i + 1}/${total})`,
      });

      const result = await processFile(files[i]);
      results.push(result);
    }

    return `Processed ${results.length} files. ${results.filter((r) => r.ok).length} succeeded.`;
  },
});
```

### Abort Handling

Pass an `AbortSignal` to support cancellation:

```typescript
const controller = new AbortController();

const result = await generateText("Process all CSV files", {
  tools: [batchProcessor],
  signal: controller.signal,
});

// Cancel after 30 seconds
setTimeout(() => controller.abort(), 30_000);
```

## Step 4: Register and Use with generateText

### Inline Tools

Pass custom tools directly in the `tools` array:

```typescript
import { generateText, tool } from "seepient";
import { z } from "zod";

const myTool = tool({
  description: "Does something custom",
  parameters: z.object({ input: z.string() }),
  execute: async ({ input }) => `Processed: ${input}`,
});

const result = await generateText("Use my custom tool with 'hello'", {
  tools: [myTool],
});

console.log(result.text);
console.log(result.toolCalls); // Array of tool invocations
```

### Global Registration

Register a tool globally so it is available in all calls:

```typescript
import { registerTool, tool } from "seepient";

registerTool(
  tool({
    name: "my_api",
    description: "Call my internal API",
    parameters: z.object({
      endpoint: z.string(),
      method: z.enum(["GET", "POST"]),
    }),
    execute: async ({ endpoint, method }) => {
      const res = await fetch(`https://api.internal/${endpoint}`, { method });
      return await res.text();
    },
  })
);

// Now available by name in any call
const result = await generateText("Check the status of service X", {
  tools: ["my_api", "core"],
});
```

## Step 5: Mix Custom and Built-in Tools

Combine custom tools with built-in tool names or group names:

```typescript
const result = await generateText("Analyze the server logs and notify the team", {
  tools: [
    "execute_shell_command",  // built-in: run shell commands
    "web_search",             // built-in: search the web
    "send_notification",      // built-in: send to Feishu/DingTalk/WeCom
    logAnalyzer,              // custom tool
    alertFormatter,           // custom tool
  ],
  maxSteps: 15,
});
```

### Using Group Names

Group names expand to the full set of built-in tools in that category:

```typescript
// Mix all core tools + all communication tools + a custom tool
const result = await generateText("Deploy and verify the service", {
  tools: ["core", "comm", deployVerifier],
});
```

| Group | Expands to |
|---|---|
| `"core"` | `execute_shell_command`, `read_file`, `write_file`, `get_current_datetime` |
| `"comm"` | `send_email`, `web_search`, `send_notification` |
| `"advanced"` | `read_website`, `take_screenshot`, `generate_image`, `optimize_prompt`, `use_skill` |
| `"all"` | All 12 built-in tools |

## Advanced Patterns

### Tool Composition

Tools can call other tools internally:

```typescript
import { executeTool } from "seepient";

const deployAndVerify = tool({
  name: "deploy_and_verify",
  description: "Deploy a service and verify it is healthy",
  parameters: z.object({
    service: z.string(),
    environment: z.string(),
  }),
  execute: async ({ service, environment }) => {
    // Use the built-in shell tool
    const deployResult = await executeTool("execute_shell_command", {
      command: `kubectl rollout restart deployment/${service} -n ${environment}`,
      rationale: `Deploying ${service} to ${environment}`,
    });

    // Wait and check health
    await new Promise((r) => setTimeout(r, 5000));
    const healthCheck = await executeTool("execute_shell_command", {
      command: `curl -sf http://${service}.${environment}.svc/health`,
      rationale: `Health check for ${service}`,
    });

    return `Deploy result: ${deployResult}\nHealth check: ${healthCheck}`;
  },
});
```

### Conditional Tools

Dynamically include tools based on the request context:

```typescript
function getToolsForUser(userRole: string) {
  const base = ["core", "web_search"];
  if (userRole === "admin") {
    base.push("execute_shell_command", adminTool);
  }
  if (userRole === "dev") {
    base.push("read_file", "write_file", deployTool);
  }
  return base;
}

const result = await generateText("List production servers", {
  tools: getToolsForUser(currentUser.role),
});
```

## Common Pitfalls

::: warning Tool name conflicts
Custom tool names must not collide with built-in tool names. Use a namespace prefix like `myapp_` to avoid conflicts.
:::

::: warning Zod schema limits
Seepient converts Zod schemas to JSON Schema using `zod-to-json-schema`. Complex schemas with refinements or transforms may not convert cleanly. For advanced schemas, use plain JSON Schema directly.
:::

::: warning Execute function must return a string
The execute function must return a string (or a `ToolResult` with an `output` string). Returning undefined, null, or objects will cause coercion to `"[object Object]"`.
:::

::: tip Keep descriptions precise
The LLM uses your tool's `description` and parameter descriptions to decide when and how to call it. Be specific about what the tool does, when to use it, and what each parameter means.
:::

## Next Steps

- [Tools Reference](/tools/reference) -- complete reference for all 12 built-in tools
- [Custom Skills Guide](/guides/custom-skills-guide) -- create reusable behavior packages
- [Build Your Own UI](/guides/build-your-own-ui) -- integrate tools into a chat interface
