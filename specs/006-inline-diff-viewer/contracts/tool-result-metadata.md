# Contract: Tool-Result Metadata Channel

**Phase 1 output.** The internal boundary contract for how a tool handler's
structured metadata reaches an adapter (the TUI) without leaking into the LLM's
context. This is the load-bearing interface change in T051.

## Scope

seepient is a CLI/SDK/library (no HTTP contract for this feature). The "contract"
here is the **in-process boundary** between Infrastructure (tool handlers) →
Core (`executeTool`, `agent-loop`) → Presentation (TUI). One source of truth
(constitution §II): `ToolResult.metadata`.

## Contract

### 1. Tool handler (producer)

A tool handler MAY return a `ToolResult` instead of a bare string:

```ts
// Built-in handlers keep returning strings (unchanged). write_file opts into metadata:
handler: async (args) => {
  // ... atomic write, capture oldContent ...
  return {
    output: `Successfully wrote to ${path} (${oldLines} -> ${newLines} lines)`,
    success: true,
    metadata: { path, oldContent, newContent, isNewFile, byteDelta, ... } as FileWriteMetadata,
  };
};
```

`ToolModule.handler` type widens to
`(args, config?, extra?) => Promise<string | ToolResult>`.

### 2. `executeTool` (normalizer)

```ts
async function executeTool(name, args, config?, extra?): Promise<ToolResult>
```

- Bare string return → `{ output: str, success: true }` (no metadata).
- `ToolResult` return → passed through **with metadata preserved**.
- The `tool()` factory's handler stops discarding `metadata` (current bug at
  `tool-executor.ts:146-149`).

### 3. `agent-loop` (attacher)

For each tool call, the loop stores the result on the step:

```ts
const toolResult = injectedModule
  ? normalize(injectedModule.handler(parsedArgs, config))   // injected tools also widen
  : await executeTool(tc.name, parsedArgs, config, execExtra);
const output = toolResult.output;
// ... existing: messages.push({ role:'tool', content: output }) — metadata NOT included ...
const toolStep: StepResult = {
  type: "tool_call",
  toolCall: { id, name, args, result: output, duration },
  metadata: toolResult.metadata,   // NEW — optional, undefined for most tools
  timestamp: now(),
};
```

**Invariant**: `output` (and only `output`) enters message history. `metadata`
rides the step only.

### 4. Adapter / TUI (consumer)

`use-agent` copies `step.metadata` onto the feed's `ToolCallEntry`. `ToolCallBlock`
parses it **defensively** (it is `unknown` at the boundary):

```ts
const meta = entry.metadata;
if (entry.name === 'write_file' && isFileWriteMetadata(meta) && !meta.diffSkipped) {
  return <DiffViewer oldContent={meta.oldContent} newContent={meta.newContent} />;
}
// else: existing plain rendering
```

`isFileWriteMetadata` is a type guard parsing the unknown — never a blind cast
(constitution "parse, don't validate" at the boundary).

## Backward compatibility

| Producer returns | `executeTool` output | `step.metadata` | TUI renders |
|---|---|---|---|
| `"some string"` | `{ output: "some string", success: true }` | `undefined` | plain (unchanged) |
| `{ output, success }` (no metadata) | as-is | `undefined` | plain (unchanged) |
| `{ output, success, metadata }` | as-is | `metadata` | diff (write_file) / ignored (others) |

Every existing tool is in row 1 or 2. Only `write_file` opts into row 3.

## Non-goals

- Metadata is **not** serialized into `SessionData` in v1 (resume drops diffs on
  old tool steps — acceptable; the file on disk is the source of truth).
- The metadata shape is **tool-specific and consumer-negotiated**, not a generic
  registry. Adding a new metadata consumer (e.g. a future `edit` tool) defines
  its own shape + type guard.
