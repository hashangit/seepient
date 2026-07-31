# Mini-PRD: Token Streaming + Live Tool Output (US2: T026, T029–T036)

**Status:** Draft — for sign-off before touching Core / providers.
**Parent:** `docs/tui-upgrade-prd.md` (Risks §1), `specs/001-tui-upgrade/tasks.md` (T026, T029–T037).

## Goal

Add **token-level streaming** (per-token assistant text) and **live tool output**
(shell stdout as it runs) as **additive, backward-compatible** enhancements to the
shared `runAgentLoop`. Non-streaming providers, headless mode, SDK, and Server
keep working unchanged. A provider without `chatStream()` silently falls back to
`chat()`.

This is the ~330-line / 8-file / 3-layer change the PRD flagged as needing its own
review before Phase 2 start.

## Scope split (two independent seams)

- **A. Token streaming** (T029–T033, T035–T036): LLM text tokens stream into the
  assistant message in real time.
- **B. Live tool output** (T026): `execute_shell_command` stdout streams into the
  tool block as the command runs.

They share nothing at the engine level. **Recommendation: land A first, then B**
(B is a separate seam and can follow once A is stable).

---

## A. Token streaming

### A1. Provider interface (T029) — `src/providers/types.ts`

Add an **optional** `chatStream()` mirroring `chat()` but returning an async
iterable of deltas. `chat()` stays the source of truth for non-streaming.

```ts
export type StreamDelta =
  | { type: 'text_delta'; content: string }                 // incremental token
  | { type: 'tool_call_begin'; index: number; id: string; name: string }
  | { type: 'tool_call_delta'; index: number; argumentsDelta: string }
  | { type: 'finish'; usage?: Usage };

export interface LLMProvider {
  chat(messages, tools, options?): Promise<ProviderResponse>;          // unchanged
  chatStream?(messages, tools, options?): AsyncIterable<StreamDelta>;  // optional
}
```

### A2. Provider implementations (T030, T031)

- `openai.ts` (OpenAI + OpenAI-compatible): `stream: true`; map SDK chunks →
  `text_delta` / `tool_call_*`. ~80 lines.
- `anthropic.ts` (Anthropic + GLM): SDK streaming events → deltas. ~80 lines.

(Impl follows each SDK's native streaming iterator; exact event shapes
confirmed at implementation time.)

### A3. Loop integration + accumulator (T032) — `src/core/agent-loop.ts`

Branch at the **single** `currentProvider.chat(...)` call site:

```ts
if (typeof currentProvider.chatStream === 'function') {
  const acc = new StreamingResponseAccumulator();
  for await (const d of currentProvider.chatStream(messages, tools, { signal })) {
    if (d.type === 'text_delta') {
      acc.appendText(d.content);
      onStep?.({ type: 'text_delta', content: d.content, timestamp: now() });
    } else if (d.type === 'tool_call_begin') acc.beginToolCall(d);
    else if (d.type === 'tool_call_delta') acc.appendToolCallArgs(d);
    else if (d.type === 'finish') usage = d.usage;
  }
  response = acc.toResponse();              // { content, tool_calls }
} else {
  response = await currentProvider.chat(messages, tools, { signal });
  onStep?.({ type: 'text', content: response.content, timestamp: now() });
}
// …existing tool-execution loop unchanged from here…
```

Key rule: **a turn emits either `text_delta` chunks (streaming) or one `text`
(non-streaming) — never both.** Downstream consumers branch on `step.type`.

`StreamingResponseAccumulator` (~50 lines, new file `src/core/stream-accumulator.ts`):
reconstructs complete `content` + `tool_calls` (with full JSON `arguments`) from
fragmented provider deltas — the part that makes streaming tool-calls reliable.

### A4. Step type (T032) — `src/core/types.ts`

```ts
export interface StepResult {
  type: 'text' | 'tool_call' | 'text_delta';
  content?: string;   // 'text': complete; 'text_delta': the incremental token
  toolCall?: { id; name; args; result; duration };
  timestamp: number;
}
```

### A5. TUI consumption — `src/adapters/cli/tui/hooks/use-agent.ts`

`use-agent` already drives `Agent.chat({ onStep })`. Extend `onStep`:

- `text_delta` → if there's a trailing **streaming** assistant entry, append to
  it; else create one. (`use-feed.updateEntry` already supports by-id patching.)
- `text` (non-streaming) → unchanged: append a complete assistant entry.

**Decision (sign-off):** the in-process TUI does **not** need a separate
`Agent.chatStream()` (T034). `onStep` already carries steps straight to React
state — the PRD itself says "forward deltas directly to React state rather than
routing through StreamManager." So **T034 is reduced to a no-op for the CLI**:
no new method; the SDK keeps its own `chatStream` (unaffected). This cuts
~80–100 lines and a redundant API.

### A6. Remote consumers (T033, T036)

- `StreamManager.toSSEStream()` — emit a `text_delta` SSE event. ~10 lines.
- SDK `chatStream` `onStep` — forward `text_delta` to `textStream`. ~5 lines.
- Server event typing — add `text_delta`. ~5 lines.

---

## B. Live tool output (T026) — `src/adapters/cli/tui/components/bash-output.tsx` + engine

Separate seam: the *tool's* stdout, not the LLM's tokens.

- `execute_shell_command` tool emits stdout chunks via `ToolContext.onUpdate`
  (already exists) as it runs.
- `runAgentLoop` forwards `onUpdate` to a new step type `tool_progress`
  (`{ type: 'tool_progress', toolCallId, chunk }`) — or an `onToolProgress` hook.
- `tool-call-block.tsx` renders the live buffer (`bash-output.tsx`).

Blocked by the same `<Static>` limitation as T028 (history is frozen), so live
output only animates the **current** tool block. Full history reflow needs the
scroll-window feed (separate decision). **Recommend: land after A.**

---

## File-by-file estimate

| File | Change | ~Lines |
|------|--------|--------|
| `src/providers/types.ts` | `chatStream?` + `StreamDelta` (T029) | ~20 |
| `src/providers/openai.ts` | `chatStream()` impl (T030) | ~80 |
| `src/providers/anthropic.ts` | `chatStream()` impl (T031) | ~80 |
| `src/core/stream-accumulator.ts` | new — `StreamingResponseAccumulator` (T032) | ~50 |
| `src/core/agent-loop.ts` | branch + `text_delta` emission (T032) | ~40 |
| `src/core/types.ts` | `text_delta` on `StepResult` (T032) | ~2 |
| `src/core/stream-manager.ts` | `text_delta` SSE (T033) | ~10 |
| `src/adapters/sdk/agent.ts` | handle `text_delta` (T036) | ~5 |
| `src/adapters/server/*` | `text_delta` event type (T036) | ~5 |
| `src/adapters/cli/tui/hooks/use-agent.ts` | `text_delta` → streaming feed entry (A5) | ~15 |
| **Total (A)** | | **~307** |
| `bash-output.tsx` + tool `onUpdate` + `tool_progress` step (B / T026) | | ~60 |

## Risks

- **Fragmented tool-call arguments** across deltas — the accumulator exists for
  this; covered by a unit test on the accumulator.
- **Backward compat** — `chatStream` is optional; absence → `chat()` (proven
  path). Headless/SDK/Server see the new step type but ignore it if unused.
- **Abort mid-stream** — `signal` is passed through; mid-stream abort must stop
  iteration and leave a coherent (partial) message.
- **Static limitation** — token streaming updates the *current* (live) assistant
  message fine; once it completes and rolls into `<Static>`, it's frozen (same as
  all history). Not a regression.

## Verification (T037)

- A streaming provider (e.g. OpenAI) shows per-token updates in the TUI assistant
  message as it types.
- A non-streaming provider falls back to `chat()` — no regression, output
  identical to today.
- `seepient -n` / SDK / Server unaffected; `pnpm test` green; headless build still
  has no `jsx-runtime`.

## Sequencing

1. **A** (token streaming): T029 → T030/T031 → T032 (+ accumulator) → StepResult
   → T033/T036 → use-agent. Verify streaming + non-streaming fallback.
2. **B** (live tool output / T026): after A, as a follow-on.
