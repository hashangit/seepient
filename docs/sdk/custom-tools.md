---
title: Custom Tools
description: Register custom tools using explicit trust models (trustedHostTool, preparedTool, brokerConnector).
---

# Custom Tools

Seepient ships with built-in tools and provides explicit extension points for custom capabilities. Custom tools are registered with explicit trust models rather than ambient host authority.

## The Honesty Ladder

Naming a tool `prepared` does not make it safe; the label declares what the platform governs. Analyzer code is trusted computing base; connector code does not exist; host code is sudo. Pick the lowest rung that fits.

## Decision Table

| Your tool… | Use | Why |
|------------|-----|-----|
| Needs arbitrary application logic (DB queries, internal APIs, household-scoped work) | `trustedHostTool` | The effect cannot be described as a supported operation; ambient authority is the honest label. Approval says "host tool"; every call is audit-labelled and allowlist-gated in server roots. |
| Performs an effect the platform understands (write/commit files, other supported operations) and you want approvals that describe the real effect | `preparedTool` | Your analyzer returns a draft (operation, effects, risk, display); the platform stamps identity and digests; the user approves the operation, not "unknown JavaScript"; audit carries digests and risk. |
| Just maps tool arguments into an existing broker (search, sends, future brokers) | `brokerConnector` | Zero of your code runs. Lowest rung; the risk is your mapping, not your code. |

### Chooser Questions

1. **Can the tool's whole effect be expressed as one existing broker operation?**  
   → `brokerConnector`.
2. **Can it be expressed as one supported operation kind that your code prepares (digests, display, effects)?**  
   → `preparedTool`.
3. **Otherwise**  
   → `trustedHostTool`, and expect host-authority approval and audit labels.

### Compliance Burden per Rung

- **`brokerConnector`**: write a correct mapping (pointer targets, no constant/binding collisions, secretRefs only for real secrets).
- **`preparedTool`**: meet the authoring checklist — a complete, honest draft; the platform does the rest.
- **`trustedHostTool`**: none at registration; all of it in your `execute` (args validation, household scoping, injection defense — the model can be tricked into calling you with hostile args, and your code is the only defense).

::: warning Deprecation: legacy `tool()` factory
The legacy `tool({ execute })` factory is deprecated and fails closed at runtime. Migrate existing tools to an explicit trust model (`trustedHostTool`, `preparedTool`, or `brokerConnector`).
:::

---

## 1. `brokerConnector` (Data-Only Mapping)

`brokerConnector` registers a declarative mapping from tool arguments directly to a platform-supported broker. No embedder code executes during preparation or execution.

```typescript
import { createAgent, brokerConnector } from "seepient";

const searchTool = brokerConnector({
  definition: {
    type: "function",
    function: {
      name: "search_docs",
      description: "Search technical documentation",
      parameters: {
        type: "object",
        properties: {
          searchQuery: { type: "string", description: "Search query" },
        },
        required: ["searchQuery"],
      },
    },
  },
  connector: "web-search",
  mapping: {
    version: 1,
    operation: "search",
    argumentBindings: { query: "/searchQuery" }, // JSON Pointer into tool args
    constants: { limit: 5 },
    secretRefs: ["tavilyApiKey"], // resolved at execution time
  },
});
```

### Mapping Rules
- `version` must be `1`.
- `argumentBindings` values are JSON Pointers (RFC 6901) into tool args.
- `constants` merge into the connector request. A constant colliding with a bound argument is rejected.
- `secretRefs` reference credential entries or environment variables (e.g. `tavilyApiKey` resolving `TAVILY_API_KEY`, `smtpPass` resolving `SMTP_PASS`, or generic environment variable names). If any declared secret cannot be resolved, execution fails closed with `CONNECTOR_SECRET_UNRESOLVED`. Secret values are never exposed in prompt displays, tool results, or audit rows.

---

## 2. `preparedTool` (Policy-Governed Preparation)

`preparedTool` registers an analyzer that prepares a serializable operation draft (`operation`, `effects`, `risk`, `display`). The platform stamps identity and computes digests, then routes the operation through the policy engine and execution boundary.

```typescript
import { createAgent, preparedTool } from "seepient";
import { join } from "node:path";

const reportTool = preparedTool({
  definition: {
    type: "function",
    function: {
      name: "generate_report",
      description: "Generate and save a weekly status report",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          content: { type: "string" },
        },
        required: ["title", "content"],
      },
    },
  },
  allowedOperationKinds: ["commit-files"],
  analyze: async (args, context) => {
    const { title, content } = (args ?? {}) as { title: string; content: string };
    const artifact = await context.artifacts.put(
      Buffer.from(`Report: ${title}\n${content}`),
      "text/plain",
    );
    const fullPath = join(context.workspace.canonicalRoot, "reports", `${title}.txt`);
    const target = {
      canonicalPath: fullPath,
      canonicalParent: join(context.workspace.canonicalRoot, "reports"),
      basename: `${title}.txt`,
      exists: false,
      finalSymlink: false,
    };

    return {
      operation: {
        kind: "commit-files",
        commits: [{ destination: target, content: artifact }],
      },
      effects: [
        {
          kind: "filesystem-write",
          targets: [{ target, mode: "create" }],
        },
      ],
      risk: "edit",
      display: {
        title: `Generate Report ${title}`,
        summary: `Writes report to reports/${title}.txt`,
        canonicalTargets: [target.canonicalPath],
        effects: ["filesystem-write"],
      },
    };
  },
});
```

### What the Platform Guarantees
- The analyzer runs once per tool call at analysis time with the real `ToolAnalysisContext`.
- Identity fields (`runId`, `toolCallId`, `toolName`, `principalId`) and digests (`argsDigest`, `actionDigest`) are stamped platform-side.
- The returned operation executes via the configured boundary (e.g. `FileCommitBroker`), never arbitrary JavaScript.

### Non-Guarantees (Honesty Section)
- **No sandboxing of analyzer code**: Analyzer JavaScript runs in-process as application TCB.
- **No new operation kinds in v1**: The closed v1 set is `commit-files`, `read-file`, `process`, `broker`, and `none`.
- **No dynamic re-registration after composition**: `setTools()` cannot add custom tool registrations dynamically.

---

## 3. `trustedHostTool` (Ambient Host Authority)

`trustedHostTool` registers an arbitrary JavaScript function with ambient in-process authority.

```typescript
import { createAgent, trustedHostTool, type HostToolContext } from "seepient";

const queryBankTool = trustedHostTool({
  definition: {
    type: "function",
    function: {
      name: "query_bank_balance",
      description: "Query bank account balance",
      parameters: {
        type: "object",
        properties: {
          accountId: { type: "string", description: "Account identifier" },
        },
        required: ["accountId"],
      },
    },
  },
  execute: async (args: unknown, _context: HostToolContext) => {
    const { accountId } = (args ?? {}) as { accountId: string };
    return JSON.stringify({ accountId, balance: 4200 });
  },
});
```

### Host Tool Rules
1. **Permission Pipeline Required**: Custom host tools require `permissionPipeline: true`.
2. **Automatic Allowlist Registration**: Passing a `trustedHostTool` in the `tools` array automatically binds the callback to the agent execution boundary.
3. **Multi-Tenant Gating**: Server roots enforce `permissions.trustedHostAllowlist`.

---

## Mixed-Rung Composition Example

You can combine built-in tool groups and custom tools across any trust model:

```typescript
import { createAgent, CORE_TOOLS } from "seepient";

const agent = await createAgent({
  permissionPipeline: true,
  tools: [
    ...CORE_TOOLS,
    searchTool,     // brokerConnector
    reportTool,     // preparedTool
    queryBankTool,  // trustedHostTool
  ],
});
```

---

## Related APIs

- [createAgent()](/sdk/create-agent) -- Stateful agent with custom tool composition
- [generateText()](/sdk/generate-text) -- One-shot execution with tool support
- [streamText()](/sdk/stream-text) -- Streaming execution with tool callbacks
- [Types](/sdk/types) -- Full TypeScript type reference
