---
title: askSeepient()
description: One-shot agent execution. Run prompts, automate tool execution, stream text and steps, or serve SSE responses.
---

# askSeepient()

Run a one-shot agent loop for a single prompt. Each call creates fresh, stateless execution context. It runs tools automatically until the model completes its response or the step limit is reached.

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

## Quick examples

### Minimal call with zero configuration

```typescript
import { askSeepient } from "seepient";

const result = await askSeepient("Explain closures in JavaScript in two sentences");
console.log(result.text);
```

### With scoped tools and a step limit

```typescript
import { askSeepient } from "seepient";

const result = await askSeepient("What is the weather in San Francisco?", {
  tools: ["web_search"],
  maxSteps: 5,
});

console.log(result.text);
console.log(result.toolCalls.length);
console.log(result.usage);
```

### Streaming to standard output

```typescript
import { askSeepient } from "seepient";

const stream = await askSeepient("Explain quantum computing simply", {
  stream: true,
  onText: (delta) => process.stdout.write(delta),
});

const finalText = await stream.fullText;
console.log("\nTotal tokens:", (await stream.usage).totalTokens);
```

## Default configuration and resolution

When you call `askSeepient(prompt)` without options, or omit specific fields, Seepient resolves the provider, model, credentials, and tools automatically through a fallback pipeline.

### Provider and model resolution

Seepient routes requests through `getDefaultProviderRuntime()`. Before execution begins, the runtime creates an immutable snapshot of the effective configuration and resolves an invocation plan:

```
1. Explicit options (options.model, options.provider, options.providerAccount)
   │
   ▼ (if omitted)
2. Persisted overlay (~/.seepient/providers-overlay.json)
   │ Matches modelAssignments.text.standard
   │
   ▼ (if no overlay or assignment found)
3. Environment variables (OPENAI_API_KEY, ANTHROPIC_API_KEY, GLM_API_KEY, OPENAI_COMPAT_*)
   │ Picks the first provider with an active key
   │
   ▼ (maps provider to standard model)
4. Built-in model catalog
   │ Selects the standard tier model (e.g. gpt-5.4, claude-sonnet-4-6-20260320)
   │
   ▼ (if no key or provider found)
Throws InferenceError (code: unconfigured_purpose)
```

1. **Explicit options take priority.** If you specify `model` or `provider` in the options object, the runtime uses those values directly.
2. **Persisted overlay configuration.** If you configured providers using `seepient setup`, the terminal UI dock, or the settings API, Seepient reads `~/.seepient/providers-overlay.json`. It looks up the assignment for `modelAssignments.text.standard`.
3. **Environment variable detection.** If you have not created an overlay, Seepient inspects environment variables in this order:
   - `OPENAI_API_KEY` (selects `openai`)
   - `ANTHROPIC_API_KEY` (selects `anthropic`)
   - `GLM_API_KEY` (selects `glm`)
   - `OPENAI_COMPAT_API_KEY` or `OPENAI_COMPAT_BASE_URL` (selects `openai-compatible`)
   The runtime assigns the first provider with an active key to `text.standard`.
4. **Built-in model catalog lookup.** Seepient looks up the recommended `standard` model for the selected provider in its catalog. For OpenAI, it defaults to `gpt-5.4`. For Anthropic, it defaults to `claude-sonnet-4-6-20260320`.
5. **Missing credentials.** If no provider accounts exist and no environment keys are present, the runtime throws an `InferenceError` with code `unconfigured_purpose`.

### Purpose and tier routing

Instead of hardcoding model names, you can request a purpose and a capability tier:

- **`purpose`** defaults to `"text"`. Other options include `"coding"`, `"plan"`, `"vision"`, `"data"`, `"commit"`, and `"dreaming"`.
- **`tier`** defaults to `"standard"`. Other options are `"efficient"` and `"complex"`.

When you specify `purpose: "coding"` and `tier: "complex"`, Seepient selects the exact model assigned to that pair in your configuration overlay, falling back to the standard text model if no specific assignment exists.

### Tool resolution and defaults

The `options.tools` parameter controls which tools the agent can call:

- **All built-in tools by default.** When you omit `options.tools`, Seepient loads the default built-in tools from its tool registry. The model can read files, write files, edit files, run shell commands, search the web, send notifications, capture screenshots, generate images, and execute skills.
- **Pure text mode (`tools: []`).** Pass an empty array to disable tool execution entirely. The model receives no tool definitions, preventing tool calls and reducing prompt token usage.
- **Selective tools.** Pass specific tool names (`tools: ["read_file", "web_search"]`) or group names (`tools: ["core"]`, `tools: ["comm"]`, `tools: ["advanced"]`).
- **Custom tools.** Pass tool objects created with `trustedHostTool()`, `preparedTool()`, or `brokerConnector()`.

### Credential resolution

The runtime resolves credentials through `CompositeCredentialStore`. It inspects sources in this sequence:

1. Process environment variables
2. Operating system keychain (macOS Keychain, Linux Secret Service, Windows Credential Manager)
3. Local credential store directory at `~/.seepient/credentials/`
4. In-memory credentials if injected via SDK options

You do not need to pass API keys in code if they exist in your shell environment or local credential store.

### Permissions and consent mode

The `consentMode` option controls the execution boundary:

- When omitted, `consentMode` operates **deny-by-default**: any unpredeclared effectful tool execution is denied unless pre-granted in policy or an `approvalBroker` is supplied (this fail-closed behavior is neither `ask-everything` nor `autonomous`).
- Pass `consentMode: "edit-enabled"` to allow reading and writing files within the workspace root (`options.cwd`, which defaults to `process.cwd()`). Destructive actions and operations outside the boundary require approval or fail with permission errors.
- Pass `consentMode: "autonomous"` to run all permitted tools within the deployment ceiling without interactive confirmation prompts.
- Pass `consentMode: "ask-everything"` to require approval for every tool execution.

### Skill discovery

The `skills` option controls skill injection:

- Defaults to `true`. Seepient scans workspace skills (`.seepient/skills`), user skills (`~/.seepient/skills`), and the cross-agent shared skills directory (`$HOME/.agents/skills`). Discovered skill descriptions are composed into the system prompt catalog.
- Pass `skills: false` to skip skill scanning.
- Pass an array of names (`skills: ["git-workflow", "review"]`) to load only those skills.

## What you can do with askSeepient

`askSeepient` handles stateless agent operations across several use cases:

- **One-shot completions.** Run single questions, translations, summaries, or structured extractions without memory between calls.
- **Autonomous tool execution.** Let the model read local files, run tests, fix code, and verify fixes in a bounded multi-step loop.
- **Scoped operations.** Restrict execution to specific tools, directory boundaries, or token limits.
- **Custom business logic.** Wire host functions, database queries, and external APIs directly into the agent loop.
- **Real-time terminal output.** Stream text deltas and tool events to console applications.
- **HTTP streaming APIs.** Stream server-sent events to web clients using standard Web API `Response` objects in Express, Hono, Next.js, or Fastify.
- **Lifecycle observability.** Monitor tool calls, steps, errors, token counts, and execution costs with hooks and step iterators.
- **Cancellation.** Cancel running completions and in-flight tool or media network requests using standard `AbortSignal` controllers.

## Parameters

### `prompt` (required)

| Type | Description |
| ---- | ----------- |
| `string` | The user instruction or question to process |

### `options` (optional)

`AskSeepientOptions` accepts the following optional fields:

| Name | Type | Default | Description |
| ---- | ---- | ------- | ----------- |
| `tenancy` | `"single" \| "multi"` | `"single"` (auto-upgraded to `"multi"` if tenant signals detected) | Tenancy mode. `"multi"` enforces fail-closed storage and runtime injection |
| `stream` | `boolean` | `false` | When `true`, returns an `AskSeepientStreamResult` with async iterables and SSE helpers |
| `model` | `string` | Standard model for provider | Model identifier (e.g. `"gpt-5.4"`, `"claude-sonnet-4-6-20260320"`) |
| `provider` | `string` | Auto-detected provider | Provider name (e.g. `"anthropic"`, `"openai"`, `"glm"`, `"openai-compatible"`) |
| `purpose` | `Purpose` | `"text"` | Purpose routing target (`"text"`, `"coding"`, `"plan"`, `"vision"`, `"commit"`, `"data"`, `"dreaming"`) |
| `tier` | `"efficient" \| "standard" \| "complex"` | `"standard"` | Capability tier hint used by the assignment resolver |
| `providerAccount` | `string` | *(none)* | Target account name in multi-account provider configurations |
| `tools` | `(string \| UserToolDefinition \| AnyToolRegistration)[]` | All 15 built-in tools | Tool names, tool groups (`"core"`, `"comm"`, `"advanced"`), or custom registrations. Pass `[]` for pure text |
| `maxSteps` | `number` | `10` | Maximum agent loop iterations before terminating |
| `systemPrompt` | `string` | *(none)* | Instructions prepended as a system message before the user prompt |
| `consentMode` | `ConsentMode` | deny-by-default | Permission mode: `"edit-enabled"`, `"autonomous"`, or `"ask-everything"` (when omitted, unpredeclared effectful tools are denied unless pre-granted in policy or an `approvalBroker` is supplied) |
| `cwd` | `string` | `process.cwd()` | Workspace root directory for file tools, boundaries, and skill discovery |
| `skills` | `string[] \| boolean` | `true` | `true` loads all discovered skills, `false` disables skill discovery, string array loads specific skills |
| `sources` | `SkillSource[]` | *(none)* | Injected skill sources for multi-tenant skill scoping. Disables ambient skill discovery in `multi` mode |
| `signal` | `AbortSignal` | *(none)* | Signal to cancel execution, propagated to LLM network requests and media operations |
| `temperature` | `number` | Provider default | Sampling temperature (0.0 to 2.0) |
| `maxTokens` | `number` | Provider default | Maximum tokens in the model completion |
| `hooks` | `Hooks` | *(none)* | Lifecycle callbacks (`beforeToolCall`, `afterToolCall`, `onStep`, `onError`, `onFinish`) |
| `middleware` | `Middleware[]` | *(none)* | Functions for request and response interception |
| `metadata` | `Record<string, unknown>` | `{}` | Custom metadata passed to middleware and audit loggers |
| `runtime` | `ProviderRuntimeContract` | `getDefaultProviderRuntime()` | Custom provider runtime instance |
| `auditStore` | `AuditStore` | Local file store | Storage backend for recording action lifecycle events |
| `policyStore` | `PolicyStore` | Local file store | Storage backend for grant snapshots and policy mutations |
| `capabilityLedger` | `CapabilityLedger` | Local file store | Storage backend for capability lease consumption and revocation |
| `principalId` | `string` | `"sdk-user"` | Identity of the calling principal for audit trails and capability grants |

### Callbacks

| Name | Type | Description |
| ---- | ---- | ----------- |
| `onText` | `(delta: string) => void` | Invoked with each text chunk as it arrives |
| `onToolCall` | `(tool: { name: string; args: Record<string, unknown>; callId: string }) => void` | Invoked when the agent starts a tool call |
| `onToolResult` | `(result: { callId: string; output: string; success: boolean }) => void` | Invoked when a tool completes execution |
| `onStep` | `(step: StepResult) => void` | Invoked after every step in the agent loop |
| `onError` | `(error: SeepientError) => void` | Invoked on execution failure in both streaming and non-streaming modes |

## Return types

### Non-streaming result

When `stream` is `false` or omitted, `askSeepient` returns `Promise<AskSeepientResult>`:

```typescript
interface AskSeepientResult {
  text: string;                                  // Final assistant response text
  steps: StepResult[];                           // Ordered record of all loop steps
  toolCalls: ToolCall[];                         // All tool calls made during execution
  usage: Usage;                                  // Token usage and calculated cost
  finishReason: "stop" | "max_steps" | "error" | "aborted";
  messages: Message[];                           // Conversation messages for this run
}
```

### Streaming result

When `stream: true`, `askSeepient` returns `Promise<AskSeepientStreamResult>`:

```typescript
interface AskSeepientStreamResult {
  textStream: AsyncIterable<string>;             // Yields text deltas as they arrive
  steps: AsyncIterable<StepResult>;              // Yields each step (text or tool call)
  fullText: Promise<string>;                     // Resolves with complete text on completion
  usage: Promise<Usage>;                         // Resolves with final token usage and cost
  finishReason: Promise<string>;                 // Resolves with finish reason
  abort: () => void;                             // Cancels the running loop and media requests
  toResponse: (options?: { headers?: Record<string, string> }) => Response;
  toSSEStream: () => ReadableStream;             // Returns a raw SSE ReadableStream
}
```

### Supporting data structures

```typescript
interface StepResult {
  type: "text" | "tool_call" | "text_delta";
  content?: string;
  toolCall?: {
    name: string;
    args: Record<string, unknown>;
    result: string;
    duration: number; // Milliseconds
  };
  timestamp: number;
}

interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: string;
}

interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
}
```

## Recipes and examples

### Pure text completion without tools

Pass `tools: []` to run pure prompt completions. The agent will not invoke file, shell, or search tools:

```typescript
import { askSeepient } from "seepient";

const result = await askSeepient("Summarize the following git diff in three bullet points:\n...", {
  tools: [],
});

console.log(result.text);
```

### Explicit provider and model

Specify the provider and model to bypass automatic discovery:

```typescript
import { askSeepient } from "seepient";

const result = await askSeepient("Generate a typed configuration schema for this project", {
  provider: "anthropic",
  model: "claude-sonnet-4-6-20260320",
  temperature: 0.2,
});

console.log(result.text);
```

### Purpose and tier routing

Route queries by intent rather than hardcoding model names:

```typescript
import { askSeepient } from "seepient";

// Uses the model mapped to coding at the complex tier
const codeResult = await askSeepient("Refactor this parser to handle circular references", {
  purpose: "coding",
  tier: "complex",
  tools: ["read_file", "edit_file"],
});

// Uses a faster, lightweight model mapped to text at the efficient tier
const quickSummary = await askSeepient("Summarize this error message", {
  purpose: "text",
  tier: "efficient",
  tools: [],
});
```

### Scoped tools and tool groups

Control which capabilities the agent can access:

```typescript
import { askSeepient } from "seepient";

// Allow only web search
const searchResult = await askSeepient("Find recent changes in TypeScript 5.8", {
  tools: ["web_search"],
});

// Allow the core file and shell group
const fileResult = await askSeepient("Read package.json and update the description field", {
  tools: ["core"], // execute_shell_command, read_file, write_file, edit_file, get_current_datetime
  consentMode: "edit-enabled",
  cwd: "/path/to/project",
});
```

### Custom host tool

Register custom functions using `trustedHostTool()`:

```typescript
import { askSeepient, trustedHostTool } from "seepient";

const dbQuery = trustedHostTool({
  definition: {
    type: "function",
    function: {
      name: "query_database",
      description: "Run a read-only SQL query against the analytics database",
      parameters: {
        type: "object",
        properties: {
          sql: { type: "string", description: "SQL query string" },
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

const result = await askSeepient("How many active users logged in yesterday?", {
  tools: [dbQuery],
});

console.log(result.text);
```

### Autonomous multi-step execution

The agent loops through tool calls automatically until it solves the prompt or hits `maxSteps`:

```typescript
import { askSeepient } from "seepient";

const result = await askSeepient(
  "Run the test suite, find why test/auth.test.ts fails, and fix the implementation",
  {
    tools: ["execute_shell_command", "read_file", "edit_file"],
    consentMode: "edit-enabled",
    maxSteps: 8,
  },
);

for (const step of result.steps) {
  if (step.type === "tool_call" && step.toolCall) {
    console.log(`Ran ${step.toolCall.name} in ${step.toolCall.duration}ms`);
  }
}

console.log(result.text);
```

### Terminal streaming with textStream

Consume text chunks as they arrive using an async iterator:

```typescript
import { askSeepient } from "seepient";

const stream = await askSeepient("Write a shell script to clean old docker containers", {
  stream: true,
});

for await (const chunk of stream.textStream) {
  process.stdout.write(chunk);
}

const finishReason = await stream.finishReason;
console.log(`\nFinished: ${finishReason}`);
```

### Step iteration for observability

Iterate over `stream.steps` to track both text generation and tool executions as they happen:

```typescript
import { askSeepient } from "seepient";

const stream = await askSeepient("Find all unused exports in src/utils and remove them", {
  stream: true,
  tools: ["read_file", "edit_file", "execute_shell_command"],
});

for await (const step of stream.steps) {
  if (step.type === "text" && step.content) {
    console.log("[Text]", step.content);
  } else if (step.type === "tool_call" && step.toolCall) {
    console.log(`[Tool] ${step.toolCall.name}(${JSON.stringify(step.toolCall.args)})`);
    console.log(`  Output: ${step.toolCall.result.slice(0, 100)}...`);
  }
}
```

### HTTP server-sent events with Express

Serve real-time agent output over HTTP using `stream.toResponse()`:

```typescript
import express from "express";
import { askSeepient } from "seepient";

const app = express();

app.get("/api/chat", async (req, res) => {
  const prompt = String(req.query.prompt ?? "Hello");
  const stream = await askSeepient(prompt, {
    stream: true,
    tools: ["web_search"],
  });

  const response = stream.toResponse();

  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  const reader = response.body?.getReader();
  if (!reader) return res.end();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
  }
  res.end();
});

app.listen(3000, () => console.log("Server listening on port 3000"));
```

### HTTP server-sent events with Hono

Hono supports standard Web API `Response` objects directly:

```typescript
import { Hono } from "hono";
import { askSeepient } from "seepient";

const app = new Hono();

app.get("/api/stream", async (c) => {
  const prompt = c.req.query("prompt") ?? "Explain event loops";
  const stream = await askSeepient(prompt, { stream: true });
  return stream.toResponse();
});

export default app;
```

`toResponse()` automatically sets SSE headers (`Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`). You can pass custom headers via `stream.toResponse({ headers: { "X-Custom": "value" } })`.

### Cancelling an in-flight execution

Cancel runs using either `stream.abort()` or an `AbortController`:

```typescript
import { askSeepient } from "seepient";

const controller = new AbortController();

// Cancel if execution takes longer than 5 seconds
const timeout = setTimeout(() => controller.abort(), 5000);

try {
  const result = await askSeepient("Process this repository", {
    signal: controller.signal,
    tools: ["read_file", "execute_shell_command"],
  });
  clearTimeout(timeout);
  console.log(result.text);
} catch (error: any) {
  if (error.code === "ABORTED") {
    console.log("Operation was cancelled before completion");
  }
}
```

The signal propagates to the LLM provider SDK, cancelling in-flight HTTP connections at the socket level.

### Lifecycle hooks

Use hooks to collect metrics, log events, or audit actions:

```typescript
import { askSeepient } from "seepient";

const result = await askSeepient("Inspect server metrics", {
  tools: ["execute_shell_command"],
  hooks: {
    beforeToolCall: ({ name, args }) => {
      console.log(`Starting tool: ${name}`);
    },
    afterToolCall: ({ name, output, duration }) => {
      console.log(`Completed tool: ${name} in ${duration}ms`);
    },
    onStep: (step) => {
      metrics.increment("agent.step.count");
    },
    onError: (error) => {
      logger.error({ err: error }, "Step failed");
    },
    onFinish: (result) => {
      logger.info({ totalTokens: result.usage.totalTokens }, "Run completed");
    },
  },
});
```

### Multi-tenant worker execution

When running `askSeepient` in multi-tenant environments (such as shared worker fleets or cloud functions), declare `tenancy: "multi"`. Multi-tenant mode requires an isolated runtime and storage backends, and guarantees zero ambient file writes or credential leakage across tenants:

```typescript
import { askSeepient } from "seepient";

const result = await askSeepient("Summarize today's invoice", {
  tenancy: "multi",
  principalId: "tenant-acme",
  runtime: tenantRuntime,
  auditStore: tenantAuditStore,
  policyStore: tenantPolicyStore,
  capabilityLedger: tenantLedger,
  stateless: true,
  tools: ["web_search"],
});
```

See [Multi-Tenant Isolation](/sdk/multi-tenant) for architecture details, store requirements, and fail-closed rules.

## Error handling

All SDK errors extend `SeepientError`:

| Error class | Code | `retryable` | Condition |
| ----------- | ---- | ----------- | --------- |
| `ProviderError` | `PROVIDER_ERROR` | `true` | LLM network error, rate limit, or authentication rejection |
| `ToolError` | `TOOL_FAILED` | `true` | A tool execution threw an unhandled exception |
| `MaxStepsError` | `MAX_STEPS` | `false` | Loop reached `maxSteps` without the model finishing |
| `AbortedError` | `ABORTED` | `false` | Execution cancelled via `AbortSignal` or `abort()` |
| `TenancyRuntimeRequiredError` | `TENANCY_RUNTIME_REQUIRED` | `false` | Missing `runtime` when running in `multi` mode |
| `TenancyStoreIncompleteError` | `TENANCY_STORE_INCOMPLETE` | `false` | Incomplete store injection in `multi` mode |
| `TenancyAmbientIoError` | `TENANCY_AMBIENT_IO` | `false` | Attempted file write outside injected stores in `multi` mode |

```typescript
import { askSeepient, ProviderError, AbortedError } from "seepient";

try {
  const result = await askSeepient("Run build", { provider: "anthropic" });
} catch (error) {
  if (error instanceof ProviderError) {
    console.error(`Provider error: ${error.message} (retryable: ${error.retryable})`);
  } else if (error instanceof AbortedError) {
    console.log("Execution was cancelled");
  }
}
```

When running in streaming mode (`stream: true`), `stream.fullText` rejects with the typed `SeepientError` if a turn fails, matching non-streaming behavior. `stream.finishReason` resolves to `"error"`, and `onError` fires.

## askSeepient versus createSeepient

| Feature | `askSeepient()` | `createSeepient()` |
| ------- | --------------- | ------------------ |
| Statefulness | Stateless. Fresh state on every call | Stateful. Retains conversation history across `.chat()` calls |
| Session persistence | No persistence. Execution state discards on finish | Built-in session store support (`memory`, `file`, custom) |
| Primary use case | One-shot scripts, server endpoints, background jobs, workers | Interactive chats, multi-turn dialogues, assistant bots |
| Streaming | Pass `{ stream: true }` | Call `agent.chatStream(prompt)` |
| Memory usage | Discarded immediately after execution | Kept in memory or loaded from session backend |

- Choose **`askSeepient()`** when each request is independent, when managing conversation history in your own database, or when building background automation tasks.
- Choose **`createSeepient()`** when you need multi-turn continuity where follow-up questions must reference earlier turns.
