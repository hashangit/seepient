# Contract: Generative Widget Protocol (L1)

**Phase 1 output.** The end-to-end contract for LLM-authored declarative widgets: tool payload → TUI render → user action → synthetic turn. The load-bearing safety property: **the LLM proposes structure; the harness mediates behavior.**

## Scope

Seepient is a CLI/SDK/Server framework. This contract covers the **in-process boundary** for the CLI TUI: how a `render_widget` tool call flows from the agent loop to a visible interactive widget and back. SDK/Server widget rendering is a future spec (the tool + types are shared; the rendering surface is CLI-only here).

Inspired by omp's `ExtensionUIContext` (`packages/coding-agent/src/extensibility/extensions/types.ts`) but **declarative-only**: omp's widgets are author-trusted code factories; Seepient's widgets are LLM-emitted data.

## Contract

### 1. Tool registration (producer side)

A new built-in tool `render_widget` registers in the static tool registry (`src/tools/index.ts`):

```ts
{
  name: 'render_widget',
  description: 'Render a structured interactive widget instead of a plain text response. Use for tables, comparisons, product cards, forms, and any response better shown visually than as prose.',
  parameters: {
    type: 'object',
    required: ['id', 'kind', 'props'],
    properties: {
      id: { type: 'string', description: 'Client-generated stable id for this widget instance.' },
      kind: { type: 'string', enum: ['table','keyvalue','chart','tree','panel','diff','form','product_card','status_grid'] },
      title: { type: 'string', maxLength: 200 },
      props: { type: 'object', description: 'Kind-specific properties (see kind schemas).' },
      actions: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'label'],
          properties: {
            id: { type: 'string' },
            label: { type: 'string' },
            style: { type: 'string', enum: ['primary','secondary','danger'] },
          },
        },
      },
    },
  },
  risk: 'safe',
}
```

Risk category `safe` (no file/network/exec) — widgets are pure presentation.

### 2. Tool handler (validator → metadata)

The handler validates the payload, then returns a `ToolResult` whose `metadata` carries the parsed `WidgetSpec` (mirrors 006's metadata-passthrough pattern — `output` stays LLM-friendly, `metadata` rides the step to the TUI):

```ts
handler: async (args) => {
  const spec = parseWidgetSpec(args);   // throws WidgetError on invalid
  return {
    output: `Rendered ${spec.kind} widget (${spec.id})${spec.actions?.length ? ` with ${spec.actions.length} action(s)` : ''}.`,
    success: true,
    metadata: { spec } as WidgetMetadata,
  };
}
```

`parseWidgetSpec` is the boundary parser (parse, don't validate — `errors.ts` precedent). On invalid input it throws `WidgetError` with `code ∈ {WIDGET_INVALID_KIND, WIDGET_INVALID_PROPS, WIDGET_DUPLICATE_ACTION}` and `retryable: true` (the model can retry with corrected JSON).

### 3. Agent loop / `executeTool` (normalizer)

Unchanged from 006: `executeTool` preserves `metadata`. `agent-loop` attaches it to the `StepResult`:

```ts
const toolStep: StepResult = {
  type: "tool_call",
  toolCall: { id, name: "render_widget", args, result: output, duration },
  metadata: toolResult.metadata,   // { spec: WidgetSpec }
  timestamp: now(),
};
```

**Invariant** (same as 006): only `output` enters message history. The `WidgetSpec` rides the step only — no LLM context pollution.

### 4. TUI / `use-agent` (consumer → block mount)

`use-agent.ts`'s `onStep` handler gains a branch for `render_widget` tool calls (parallel to the existing `manage_todos` branch):

```ts
if (tc.name === 'render_widget') {
  const meta = tc.metadata as WidgetMetadata | undefined;
  if (meta?.spec) {
    widgetHost.mount(meta.spec);   // creates a ChatBlock, appends a BlockEntry
  }
  return;  // don't append a generic tool block
}
```

`widgetHost` is the T4-2 widget host controller. It calls `useFeed.mountBlock('widget', spec)` and returns a `ChatBlockInstance`.

### 5. Widget renderer (skeleton + kind dispatch)

```tsx
<WidgetBlock spec={spec} finalized={entry.finalized} onAction={onAction} />
```

- Renders the skeleton frame (bordered `<Box>` + title slot + optional action bar).
- Dispatches on `spec.kind` to a kind-specific renderer (e.g. `<TableWidget>`, `<ProductCardWidget>`, `<FormWidget>`).
- The action bar renders `spec.actions` as focusable buttons (keyboard navigable; mouse-click only if inside an overlay — R11).

### 6. Action round-trip (consumer → new turn)

When the user activates an action (Enter on focused button, or form submit):

```ts
// Form widgets validate field values against each field's declared `type` BEFORE dispatch.
// Invalid values are surfaced inline in the widget (red marker + message); they are NOT sent.
if (spec.kind === 'form') {
  const validation = validateFormValues(spec.props.fields, formValues);
  if (!validation.ok) {
    widgetHost.surfaceValidationError(spec.id, validation.errors);  // inline, no dispatch
    return;
  }
}

const dispatch: WidgetActionDispatch = {
  widgetId: spec.id,
  actionId: action.id,
  state: kind === 'form' ? formValues : undefined,
  timestamp: new Date().toISOString(),
};
const synthetic = `[widget:${dispatch.widgetId}] action "${dispatch.actionId}"${dispatch.state ? ` state ${JSON.stringify(dispatch.state)}` : ''}`;
submit(synthetic);   // existing useAgent.submit — fires a new agent turn
```

**Form validation rules** (per field `type`):
- `text`: non-empty if required; else any string.
- `number`: parses as finite `Number(value)`; rejects `NaN`/`Infinity`.
- `boolean`: coerced via "true"/"false"/"1"/"0"/"yes"/"no".
- `select`: value ∈ field's `options[].value`.

Invalid fields render with a red marker + message; the dispatch is suppressed. This closes the boundary before malformed values reach the agent.

`submit` is the existing `useAgent.submit(input)` — the same path a typed user message takes. The agent receives the synthetic message as a normal user turn; no agent-loop change.

After dispatch:
- For `form`/`product_card` (one-shot actions): the block finalizes (freezes into history).
- For multi-action widgets (`actions.length > 1`): the block stays live until the agent emits a different widget or the turn ends.

### 7. Persistence / resume

On session resume, `feed-serializer.ts` reconstructs widget blocks from persisted `render_widget` tool messages as **finalized, non-interactive** entries (the spec is rendered; actions are visible but disabled). This matches omp's behavior and avoids resuming a half-interacted widget.

**Other block kinds** (`thinking`, `live-tool`, `custom`) are **transient by design** — they exist only during the turn that produced them. On resume they are **not** re-derived (there is no persisted source for them; unfinalized live blocks are dropped per `feed-lifecycle.md` §6). Only `widget` blocks round-trip through `SessionData`, because only widgets have a persisted source (`render_widget` tool calls in message history).

## Backward compatibility

| Caller behavior | Result |
|---|---|
| Model emits valid `render_widget` | widget mounts |
| Model emits invalid `kind`/`props` | `WidgetError` returned to model (retryable); no TUI change |
| Model never uses `render_widget` | unchanged (tool is additive; existing tools unaffected) |
| Session resumed with widget entries | rendered finalized, non-interactive |

## Non-goals

- **L2 nestable layout DSL** — deferred (see spec.md).
- **L3 model-emitted executable code** — explicit non-goal; safety.
- **SDK/Server widget rendering** — future spec (the tool + types are reusable; the rendering surface is CLI-only here).
- **Widget persistence of in-flight interactions** — finalized-only resume (above).
