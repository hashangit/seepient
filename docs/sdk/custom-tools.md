---
title: Custom Tools
description: Build and register custom tools using the tool() factory, Zod schemas, and tool groups.
---

# Custom Tools

Seepient Agent ships with 12 built-in tools, but you can create your own using the `tool()` factory. Custom tools are first-class citizens -- they work identically to built-in tools in `generateText()`, `streamText()`, and `createAgent()`.

## `tool()` factory

```typescript
import { tool } from "seepient";

function tool(definition: UserToolDefinition): ToolModule
```

### UserToolDefinition

```typescript
interface UserToolDefinition {
  /** Tool name. Auto-generated if omitted (e.g. "custom_tool_1"). */
  name?: string;

  /** Description of what the tool does. The LLM uses this to decide when to call it. */
  description: string;

  /** Zod schema defining the tool's parameters. */
  parameters: unknown;

  /** The function that runs when the LLM calls this tool. */
  execute: (args: unknown, context: ToolContext) => Promise<string | ToolResult>;
}
```

### ToolContext

Passed as the second argument to `execute`:

```typescript
interface ToolContext {
  /** Report progress back during long-running operations. */
  onUpdate?: (progress: { percentage: number; message?: string }) => void;

  /** AbortSignal for cancellation. */
  signal?: AbortSignal;

  /** Extra config from the agent or generateText call. */
  config?: Record<string, unknown>;
}
```

### ToolResult

Return a plain `string` for simple output, or a structured `ToolResult`:

```typescript
interface ToolResult {
  output: string;
  success: boolean;
  metadata?: Record<string, unknown>;
}
```

## Basic tool

```typescript
import { generateText, tool } from "seepient";

const greeter = tool({
  name: "greet",
  description: "Greets a person by name",
  parameters: z.object({
    name: z.string().describe("The person's name"),
  }),
  execute: async ({ name }) => `Hello, ${name}! Welcome to Seepient Agent.`,
});

const result = await generateText("Greet Alice", {
  tools: [greeter],
});

console.log(result.text);
// => "Hello, Alice! Welcome to Seepient Agent."
```

## Tool with Zod parameters

Zod schemas are automatically converted to JSON Schema for the LLM. Use `.describe()` to give the LLM hints about each parameter:

```typescript
import { generateText, tool } from "seepient";
import { z } from "zod";

const dbQuery = tool({
  name: "db_query",
  description: "Execute a read-only SQL query against the analytics database",
  parameters: z.object({
    sql: z.string().describe("SQL SELECT query to execute"),
    database: z
      .enum(["analytics", "users", "events"])
      .describe("Target database"),
    limit: z
      .number()
      .min(1)
      .max(1000)
      .default(100)
      .describe("Max rows to return"),
  }),
  execute: async ({ sql, database, limit }) => {
    const rows = await db.execute(sql, { database, limit });
    return JSON.stringify(rows);
  },
});

const result = await generateText(
  "How many users signed up last week?",
  { tools: [dbQuery] },
);
```

::: tip
Always use `.describe()` on your Zod fields. The descriptions are sent to the LLM and help it call the tool correctly.
:::

## Tool with progress reporting

Long-running tools can report progress via `context.onUpdate`:

```typescript
import { generateText, tool } from "seepient";
import { z } from "zod";

const batchProcessor = tool({
  name: "process_batch",
  description: "Process a batch of items with progress tracking",
  parameters: z.object({
    items: z.array(z.string()).describe("Items to process"),
  }),
  execute: async ({ items }, context) => {
    const results: string[] = [];

    for (let i = 0; i < items.length; i++) {
      // Check for cancellation
      if (context.signal?.aborted) {
        return "Batch processing was cancelled";
      }

      // Report progress
      context.onUpdate?.({
        percentage: Math.round(((i + 1) / items.length) * 100),
        message: `Processing item ${i + 1} of ${items.length}`,
      });

      // Do the work
      const result = await processItem(items[i]);
      results.push(result);
    }

    return JSON.stringify({ processed: results.length, results });
  },
});
```

## Mixing custom and built-in tools

Custom tools can be mixed with built-in tool names or group names:

```typescript
import { generateText, tool } from "seepient";
import { z } from "zod";

const lookupTool = tool({
  name: "crm_lookup",
  description: "Look up a customer in the CRM",
  parameters: z.object({
    email: z.string().email(),
  }),
  execute: async ({ email }) => {
    const customer = await crm.findByEmail(email);
    return JSON.stringify(customer);
  },
});

// Mix: built-in group name + individual built-in + custom tool
const result = await generateText(
  "Look up customer john@example.com and send them a summary email",
  {
    tools: ["core", "send_email", lookupTool],
  },
);
```

## Tool groups

Seepient Agent organizes its 12 built-in tools into groups. You can reference groups by name:

| Group         | Constant          | Tools                                                              |
| ------------- | ----------------- | ------------------------------------------------------------------ |
| **Core**      | `CORE_TOOLS`      | `execute_shell_command`, `read_file`, `write_file`, `get_current_datetime` |
| **Comm**      | `COMM_TOOLS`      | `send_email`, `web_search`, `send_notification`                    |
| **Advanced**  | `ADVANCED_TOOLS`  | `read_website`, `take_screenshot`, `generate_image`, `optimize_prompt`, `use_skill` |
| **All**       | `ALL_TOOLS`       | All 12 built-in tools                                              |

### Using group constants

```typescript
import { generateText, CORE_TOOLS, COMM_TOOLS, ALL_TOOLS } from "seepient";

// By string name
await generateText("Read ./package.json", { tools: ["core"] });

// By constant (identical effect)
await generateText("Read ./package.json", { tools: [CORE_TOOLS] });

// Combine groups
await generateText("Research and notify", {
  tools: ["core", "comm"],
});
```

### Resolving tools programmatically

Use `resolveTools()` to expand groups and names into concrete definitions:

```typescript
import { resolveTools, ALL_TOOLS } from "seepient";

// Expand "all" into individual tool definitions
const definitions = resolveTools(["core", "web_search"]);
// => ToolDefinition[] for execute_shell_command, read_file, write_file,
//    get_current_datetime, web_search
```

## Registering tools globally

Register a custom tool so it is available everywhere without passing it explicitly:

```typescript
import { registerTool, tool } from "seepient";

const myTool = tool({
  name: "my_api",
  description: "Call my internal API",
  parameters: z.object({ endpoint: z.string() }),
  execute: async ({ endpoint }) => {
    const res = await fetch(`https://internal.api/${endpoint}`);
    return await res.text();
  },
});

registerTool(myTool);

// Now available in any generateText/streamText/createAgent call
const result = await generateText("Check the status of the API", {
  tools: ["my_api"],
});
```

## Related APIs

- [generateText()](/sdk/generate-text) -- One-shot execution with tool support
- [streamText()](/sdk/stream-text) -- Streaming execution with tool callbacks
- [createAgent()](/sdk/create-agent) -- Stateful agent with dynamic tool switching
- [Types](/sdk/types) -- Full TypeScript type reference
