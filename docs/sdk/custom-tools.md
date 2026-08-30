---
title: Custom Tools
description: Register custom tools using explicit trust models (trustedHostTool).
---

# Custom Tools

Seepient Agent ships with 15 built-in tools and provides explicit extension points for custom capabilities. Custom tools are registered with explicit trust models rather than ambient host authority.

## Explicit Trust Models

Seepient recognizes three distinct custom-tool trust models:

| Trust Model | Factory / Status | Description | Execution Authority |
| ----------- | ---------------- | ----------- | ------------------- |
| **Trusted Host** | `trustedHostTool()` | Arbitrary JavaScript callbacks with ambient host authority. | Host callback map (in-process). Audit-labelled. |
| **Prepared Analyzer** | Planned (0.6.0) | Application analyzer generating serializable `PreparedToolAction` operations. | Boundary/broker pipeline. Policy-governed. |
| **Broker Connector** | Planned (0.6.0) | Data-only argument-to-request mapping via JSON Pointers. | Typed broker backend. Zero developer callback execution. |

::: warning Deprecation: legacy `tool()` factory
The legacy `tool({ execute })` factory is deprecated and fails closed at runtime. Migrate existing tools to `trustedHostTool()`.
:::

---

## 1. `trustedHostTool()`

`trustedHostTool` registers an arbitrary JavaScript function. This is the primary extension point for embedding custom application logic, database access, or external APIs directly into an agent:

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
  execute: async (args: unknown, context: HostToolContext) => {
    const { accountId } = (args ?? {}) as { accountId: string };
    const balance = await bankService.getBalance(accountId);
    return JSON.stringify({ accountId, balance });
  },
});

// Pass directly to createAgent with permissionPipeline enabled:
const agent = await createAgent({
  permissionPipeline: true,
  tools: [queryBankTool],
});

const response = await agent.chat("What is the balance of account acc_123?");
console.log(response.text);
```

### Host Tool Requirements & Execution Rules

1. **Permission Pipeline Required**: Custom host tools require `permissionPipeline: true` on `createAgent()`, `generateText()`, or `streamText()`.
2. **Automatic Allowlist Registration**: Passing a `trustedHostTool` registration explicitly in the `tools` array automatically binds the callback to the agent execution boundary and adds the tool name to the effective allowlist for that lifecycle.
3. **Multi-Tenant / Server Root Gating**: In multi-tenant or server environments, host execution is additionally gated by the operator setting `permissions.trustedHostAllowlist`. Requests and model prompts cannot bypass this allowlist.

---

## 2. `preparedTool` (Planned in 0.6.0)
 
The `preparedTool` trust model is defined for analyzers that inspect inputs and emit serializable operations for policy evaluation. Its execution runtime and dispatch wiring land with spec 020 in version 0.6.0. For custom capabilities today, use `trustedHostTool()`.
 
---
 
## 3. `brokerConnector` (Planned in 0.6.0)
 
The `brokerConnector` trust model is defined for data-only argument-to-request mappings via JSON Pointers directly to backend brokers. Its connector registry and dispatch wiring land with spec 020 in version 0.6.0. For custom capabilities today, use `trustedHostTool()`.

---

## Migrating from Global `registerTool` to Per-Agent Composition

The ambient global tool registry fallback has been removed. Built-in tools continue to be referenced by string names (e.g. `"read_file"` or `"core"`), but custom tools must now be passed explicitly as registration objects per agent or per call.

### Before (Legacy ambient pattern)

```typescript
// ❌ Legacy / Removed: Ambient global registration
import { registerTool, tool } from "seepient";

const myTool = tool({
  name: "get_user_info",
  description: "Get user info",
  parameters: {},
  execute: async () => ({ name: "Alice" }),
});

registerTool(myTool); // No longer binds into execution boundary

const agent = await createAgent({
  tools: ["get_user_info"], // Fails with HOST_TOOL_NOT_REGISTERED
});
```

### After (Per-agent explicit registration)

```typescript
// ✅ Recommended: Direct registration per agent
import { createAgent, trustedHostTool } from "seepient";

const userInfoTool = trustedHostTool({
  definition: {
    type: "function",
    function: {
      name: "get_user_info",
      description: "Get user info",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  execute: async () => JSON.stringify({ name: "Alice" }),
});

const agent = await createAgent({
  permissionPipeline: true,
  tools: [userInfoTool],
});
```

---

## One-Shot `generateText()` and `streamText()`

Custom tools work identically in stateless execution:

```typescript
import { generateText, trustedHostTool } from "seepient";

const mathTool = trustedHostTool({
  definition: {
    type: "function",
    function: {
      name: "compute_square",
      description: "Calculate square of a number",
      parameters: {
        type: "object",
        properties: { n: { type: "number" } },
        required: ["n"],
      },
    },
  },
  execute: async (args) => {
    const { n } = (args ?? {}) as { n: number };
    return String(n * n);
  },
});

const result = await generateText("What is the square of 12?", {
  permissionPipeline: true,
  tools: [mathTool],
});

console.log(result.text);
```

---

## Built-In Tool Groups

Seepient Agent organizes its 15 built-in tools into groups:

| Group | Constant | Tools |
| ----- | -------- | ----- |
| **Core** | `CORE_TOOLS` | `execute_shell_command`, `read_file`, `write_file`, `edit_file`, `get_current_datetime`, `manage_todos`, `render_widget` |
| **Comm** | `COMM_TOOLS` | `send_email`, `web_search`, `send_notification` |
| **Advanced** | `ADVANCED_TOOLS` | `read_website`, `take_screenshot`, `generate_image`, `optimize_prompt`, `use_skill` |
| **All** | `ALL_TOOLS` | All 15 built-in tools |

You can mix built-in group names, built-in tool names, and custom tool registrations in `tools`:

```typescript
const agent = await createAgent({
  permissionPipeline: true,
  tools: ["core", "web_search", userInfoTool],
});
```

---

## Related APIs

- [createAgent()](/sdk/create-agent) -- Stateful agent with custom tool composition
- [generateText()](/sdk/generate-text) -- One-shot execution with tool support
- [streamText()](/sdk/stream-text) -- Streaming execution with tool callbacks
- [Types](/sdk/types) -- Full TypeScript type reference
