# Deferred TUI Items — Scope & PRD

**Created**: 2026-06-14  
**Updated**: 2026-06-15  
**Status**: Deferred from US4 (T051, T052, T049) + cross-cutting polish  
**Parent spec**: `specs/001-tui-upgrade/tasks.md` (Phase 6 US4, Phase 7 Polish)

---

## T051 — Inline Diff Viewer + Safe Write Infrastructure — ✅ DONE

**Implemented 2026-06-17** (`specs/006-inline-diff-viewer/`). `write_file` now writes
atomically (same-dir temp + `fs.rename`) and captures old content as `FileWriteMetadata`
on the tool step; the TUI renders an inline unified diff (`tui/diff/` + `diff-viewer.tsx`)
via the `diff` package, with Pi-style context-collapse and a size cap. The metadata channel
threads `executeTool` → `agent-loop` → `StepResult.metadata` → TUI without entering LLM
context. 317 tests green.

### Problem
Two problems, tightly coupled:

1. **No diff visibility**: When the agent calls `write_file`, the tool-call block
   shows "Successfully wrote to <path>" — the user cannot see *what changed*.
   There's no visual diff (added/removed/unchanged lines).

2. **Unsafe writes**: The `write_file` tool is a **blind overwrite**:
   - No old-content capture (can't produce a diff or undo).
   - No atomic write (a crash mid-write leaves a corrupted/partial file).
   - No backup (the old content is lost forever).
   - No validation (the agent could write garbage, truncating a file to 0 bytes).
   - No rollback (if the write fails midway, the original is already destroyed).

   **Current code** (`src/tools/core.ts` WriteFileTool handler):
   ```typescript
   handler: async (args) => {
     await fs.mkdir(path.dirname(args.path), { recursive: true });
     await fs.writeFile(args.path, args.content, 'utf-8');
     return `Successfully wrote to ${args.path}`;
   }
   ```
   This is a fire-and-forget overwrite with zero safety.

### Target UX
1. **After a write_file call**, the tool-call block shows a **unified diff**
   (green added, red removed, dim context). Collapsed by default (Ctrl+O expands).
   For new files, all-green. For edits, mixed.

2. **Safe write**: The tool never corrupts a file:
   - **Atomic write**: writes to a temp file, then `fs.rename` (atomic on POSIX).
     A crash during write leaves the original intact.
   - **Old-content capture**: reads before writing → available for diff + implicit
     backup. If the write fails, the old content is preserved.
   - **Backup file**: optionally writes the old content to `<path>.bak` before
     overwriting. The user can recover manually if needed. Auto-cleaned after N
     successful writes or on session end (configurable).

### Scope

#### Part 1: Safe write_file tool (src/tools/core.ts)

**Changes to the WriteFileTool handler:**

```typescript
handler: async (args, _config, extra) => {
  const filePath = args.path;
  const newContent = args.content;
  let oldContent: string | null = null;

  // 1. Capture old content (for diff + implicit backup).
  try {
    oldContent = await fs.readFile(filePath, 'utf-8');
  } catch {
    // File doesn't exist yet — new file, no old content.
  }

  // 2. Atomic write: temp file + rename.
  const tmpPath = filePath + '.seepient-tmp-' + Date.now();
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(tmpPath, newContent, 'utf-8');
    await fs.rename(tmpPath, filePath); // atomic on POSIX
  } catch (error) {
    // Clean up temp if rename failed.
    try { await fs.unlink(tmpPath); } catch {}
    return `Error writing file: ${error.message}`;
  }

  // 3. Build result with old/new content for the TUI's diff viewer.
  //    The LLM only sees the `output` string (not the metadata).
  const lines = newContent.split('\n').length;
  const oldLines = oldContent ? oldContent.split('\n').length : 0;
  return {
    output: `Successfully wrote to ${filePath} (${oldLines} -> ${lines} lines)`,
    success: true,
    metadata: { oldContent, newContent, path: filePath },
  };
}
```

**Key design decisions:**
- **Old content in metadata, not output**: The LLM sees only `"Successfully wrote
  to X (N -> M lines)"` — no context bloat. The TUI reads `metadata.oldContent`
  for the diff.
- **Atomic write via temp + rename**: `fs.rename` is atomic on POSIX (macOS,
  Linux, Docker). On Windows, it's not guaranteed atomic (but close enough for a
  dev tool). The temp file is cleaned up on failure.
- **No `.bak` file (v1)**: The old content is in memory (metadata) — sufficient
  for the diff. A `.bak` mechanism can be added if the user wants persistent
  rollback. For now, the in-memory metadata + the diff viewer's undo (if
  implemented) cover the common case.

**ToolResult metadata pass-through:**
Currently, `executeTool` returns only the string `output` from the handler. To
pass `metadata` through to the TUI, the engine needs a small change:

1. `executeTool` returns `Promise<string>` → change to `Promise<{ output: string;
   metadata?: Record<string, unknown> }>` (or return the ToolResult directly).
2. The loop captures the metadata and attaches it to the `tool_call` step:
   ```typescript
   const toolStep: StepResult = {
     type: "tool_call",
     toolCall: { id, name, args, result: output, duration },
     metadata, // new field on StepResult
     timestamp: now(),
   };
   ```
3. `StepResult` gains an optional `metadata?: Record<string, unknown>` field.
4. `use-agent` reads `step.toolCall.metadata` (or `step.metadata`) for the diff
   data when rendering the tool-call-block.

This is a small, backward-compatible engine change (~10 lines across
`tool-executor.ts`, `agent-loop.ts`, `types.ts`).

#### Part 2: Diff computation

A minimal LCS-based line diff (~50-80 lines). OR use the `diff` npm package
(`pnpm add diff`) — well-maintained, ~30KB, zero deps. The PRD allows adding
deps with justification; `diff` is the standard diff library for Node.js.

**Recommendation**: Start with a minimal inline diff (no dep). If the user
encounters edge cases (whitespace, moved blocks), add `diff` later.

```typescript
// Minimal LCS line diff (inline, no dep)
function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  // ... LCS table → backtrack → produce diff lines
}

interface DiffLine {
  type: 'added' | 'removed' | 'context';
  text: string;
  oldNum?: number;
  newNum?: number;
}
```

#### Part 3: DiffViewer component

```tsx
// src/adapters/cli/tui/components/diff-viewer.tsx
function DiffViewer({ oldContent, newContent }: { oldContent: string; newContent: string }) {
  const diff = computeLineDiff(oldContent, newContent);
  return (
    <Box flexDirection="column">
      {diff.map((line, i) => {
        const color = line.type === 'added' ? green
                    : line.type === 'removed' ? red : fgDim;
        const prefix = line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ';
        return <Text key={i} color={color}>{prefix} {line.text}</Text>;
      })}
    </Box>
  );
}
```

#### Part 4: Tool-call-block integration

The tool-call-block detects `write_file` with metadata → renders DiffViewer
instead of raw output:

```tsx
// In ToolCallBlock:
if (entry.name === 'write_file' && entry.metadata?.oldContent != null) {
  return <DiffViewer oldContent={entry.metadata.oldContent} newContent={entry.metadata.newContent} />;
}
```

### File estimate
| File | Change | ~Lines |
|------|--------|--------|
| `src/tools/core.ts` (WriteFileTool) | Atomic write + old-content capture + ToolResult | ~35 |
| `src/core/tool-executor.ts` (executeTool) | Return metadata from handler | ~10 |
| `src/core/types.ts` (StepResult) | Add `metadata?` field | ~2 |
| `src/core/agent-loop.ts` | Pass metadata to the step | ~5 |
| `src/adapters/cli/tui/components/diff-viewer.tsx` (new) | Diff rendering | ~60 |
| Diff algorithm (inline) | LCS line diff | ~60 |
| `src/adapters/cli/tui/components/tool-call-block.tsx` | Detect write_file → render diff | ~10 |
| `src/adapters/cli/tui/hooks/use-agent.ts` | Pass metadata through to feed entry | ~5 |
| `src/adapters/cli/tui/types.ts` | Add `metadata?` to ToolCallEntry | ~2 |
| **Total** | | **~189** |

### Risks
- **ToolResult metadata pass-through**: The engine change (executeTool → loop →
  step → TUI) must be backward-compatible. Providers/handlers that return plain
  strings work unchanged (no metadata → no diff → plain text rendering).
- **Large files**: Diffs of very large files could be huge. Cap at N lines or
  truncate (the diff viewer shows the first N diff hunks + "... more").
- **Binary files**: write_file could write binary content. Diff makes no sense.
  Detect (check for null bytes or non-UTF-8) → skip diff, show plain "File written."
- **Atomic write on Windows**: `fs.rename` is not guaranteed atomic on Windows
  if the target file exists. A fallback: unlink + rename (small window of risk).
  Acceptable for a dev tool.

### Prerequisites
- None blocking. Can be implemented independently.

### Corruption prevention checklist (what the safe write guarantees)
| Scenario | Current (blind overwrite) | After (safe write) |
|----------|--------------------------|-------------------|
| Write succeeds | File overwritten | File overwritten (atomic rename) |
| Process crashes during write | **Corrupted file** (partial write) | **Original intact** (temp file orphaned, auto-cleaned) |
| Write fails (disk full, permissions) | **File may be corrupted** (if partial) | **Original intact** (temp write failed, rename never happens) |
| Agent writes garbage (truncates file) | **Data lost** | Data lost (but old content in metadata → diff shows the damage → user can undo) |
| Agent overwrites wrong file | **Data lost** | Old content in metadata → diff shows → user spots the mistake |

The safe write doesn't prevent the agent from writing wrong content (that's the
LLM's responsibility + the permission gate). But it ensures the **write itself
is atomic** (no partial/corrupt files) and the **old content is captured** (for
diff + potential undo).

---

## T052 — Collapsible Thinking/Reasoning Blocks

> **Status (2026-06-17): DEFERRED until the pi-ai provider migration.** See
> "Decision: DEFER" and the migration-relevance tags below. ~70 of ~140 lines
> are throwaway pre-migration; pi-ai's native `reasoning` option collapses the
> provider layer. Full per-adapter parity surface recorded below so the
> post-migration implementer doesn't re-derive it.

### Problem
Some providers (Anthropic, OpenAI o-series) emit **reasoning/thinking content**
alongside the main response. Currently, Seepient Agent's providers don't surface
reasoning content — `ProviderResponse.content` is only the main text. The
reasoning is invisible to the user, even though it's valuable for transparency
("why did the agent decide X?").

### Target UX
A collapsible `ReasoningBlock` component in the feed. When the provider emits
reasoning content, it renders as a dimmed, bordered block (collapsed by
default) that the user can expand via `/thinking` or a key. Shows the model's
chain-of-thought in dim text.

### Scope
1. **Provider support**: Both providers need to extract reasoning content:
   - **Anthropic**: The Messages API returns `thinking` content blocks
     (`type: 'thinking'`) when extended thinking is enabled. The provider must
     enable thinking (API parameter) + extract thinking blocks into a separate
     field on `ProviderResponse` (e.g., `reasoning?: string`).
   - **OpenAI o-series**: The Chat Completions API returns reasoning summaries
     (`choices[0].message.reasoning_summary` or similar — API-dependent).
   - **GLM**: Unknown — depends on the model. May not support reasoning.

2. **ProviderResponse type change**: Add `reasoning?: string` to
   `ProviderResponse`. The loop passes it through as a new field on the
   `text` step (or a new `reasoning` step type).

3. **StepResult change**: Either:
   - Add `reasoning?: string` to the `text` StepResult (the reasoning accompanies
     the text response).
   - OR add a new `reasoning` step type (`{ type: 'reasoning', content, timestamp }`).

4. **ReasoningBlock component**: A bordered, collapsed-by-default block:
   - Collapsed: `[~] Reasoning (N lines) — /thinking to expand`
   - Expanded: dim text showing the reasoning content.
   - Toggle via `/thinking` slash command (sets `showReasoning` state → bumps
     staticKey to remount Static with the new state).

5. **use-agent**: Handle the reasoning step → store it alongside the assistant
   message → render ReasoningBlock before the AssistantMessage.

### File estimate
| File | Change | ~Lines |
|------|--------|--------|
| `src/providers/types.ts` | Add `reasoning?` to ProviderResponse + StreamDelta | ~5 |
| `src/providers/anthropic.ts` | Enable thinking + extract thinking blocks | ~30 |
| `src/providers/openai.ts` | Extract reasoning_summary for o-series | ~15 |
| `src/core/types.ts` | Add `reasoning` to StepResult (or new step type) | ~5 |
| `src/core/agent-loop.ts` | Surface reasoning in the text step | ~10 |
| `src/adapters/cli/tui/components/reasoning-block.tsx` (new) | Collapsible block | ~50 |
| `src/adapters/cli/tui/hooks/use-agent.ts` | Handle reasoning in onStep | ~10 |
| `src/adapters/cli/tui/app.tsx` | `/thinking` toggle + render | ~15 |
| **Total** | | **~140** |

### Risks
- **Provider API dependency**: Anthropic thinking requires `thinking: { type:
  'enabled', budget_tokens: N }` in the API call — changes the request shape.
  GLM may not support it (unknown). OpenAI's reasoning API is evolving.
- **Token cost**: Extended thinking uses tokens (budget_tokens). The footer's
  context-window stat should account for reasoning tokens.
- **Backward compat**: Providers without reasoning → no reasoning step →
  ReasoningBlock never renders. Safe.
- **Streaming**: Reasoning can stream (thinking deltas). The stream would need a
  `reasoning_delta` type. Deferred — for v1, show reasoning on completion.

### Prerequisites
- Verify Anthropic/GLM thinking API support before implementing.
- The `--thinking` flag (or `/thinking` command) enables extended thinking at
  the provider level (sends `thinking: { type: 'enabled' }`). Without the flag,
  the provider doesn't return thinking blocks.

### Decision: DEFER until the pi-ai provider migration lands

**Decided 2026-06-17.** The work splits cleanly along the migration boundary:
~70 of ~140 lines are throwaway if done against the current hand-rolled
providers, including the gnarliest part (Anthropic's rule that `thinking`
blocks must be echoed back *with their cryptographic signature* on every
tool-use turn — easy to get subtly wrong). pi-ai already handles this.
Implement T052 as one clean post-migration pass, not incrementally.

**Migration is imminent (days–2 weeks) and the user actively uses reasoning
models.** These pull in opposite directions, but the timing wins: a partial
pass now means re-touching the streaming path when pi-ai lands, with ~70
lines of throwaway in between. The whole task post-migration is ~60 lines TUI
+ ~5 lines to flip pi-ai's `reasoning` option + the adapter-parity work below.

### Correction: pi-ai DOES support extended thinking

`docs/llm-provider-management-comparison.md` §2.7 claims pi-ai has *"No
built-in support for provider-specific features (e.g., Anthropic's extended
thinking)."* **This is factually wrong** (verified against pi-ai 0.73.1):
- pi-ai has a first-class **`reasoning` option** (off by default) enabling
  extended thinking for Claude, o3, and Gemini 2.5.
- It consumes Anthropic's native `thinking` content blocks and **normalizes
  them to tagged text** when round-tripping to non-Anthropic providers.
- Its model registry reports per-model thinking support (resolves the "GLM
  unknown" gap in the Scope above for free).

**This correction must be applied to the comparison doc before relying on it
for migration design.** Post-migration, Layer 1 below collapses to "pass
`reasoning: { enabled: true }`, read reasoning from the normalized response."

### Implementation layers (tagged by migration relevance)

The original File estimate (above) is CLI-only. Since all adapters must reach
parity, the real surface is three layers. Each item is tagged by whether it
survives the pi-ai migration:

| Relevance tag | Meaning |
|---------------|---------|
| **[SURVIVES]** | Unchanged by the migration — do post-migration |
| **[PARTIAL]** | The shape survives; the source/option-threading simplifies |
| **[THROWAWAY]** | Rewritten or removed by pi-ai — do NOT do pre-migration |

#### Layer 1 — Provider extraction **[THROWAWAY]**

The part being thrown away. Hand-rolled against the current providers:
- `ProviderResponse.reasoning?` (`providers/types.ts:19`) + a
  `reasoning_delta` variant in `StreamDelta` (`providers/types.ts:34`).
- `AnthropicProvider`: inject `thinking: { type: 'enabled', budget_tokens }`,
  extract `thinking` blocks, **reconstruct thinking blocks (with signature)
  in `buildRequest()` (`anthropic.ts:22`) for the tool-use round-trip**.
- `OpenAIProvider`: extract `reasoning_summary` for o-series.
- GLM: support unknown (guesswork).

**Post-migration this is ~5 lines:** pass pi-ai's `reasoning: { enabled }`,
read normalized reasoning. Do not implement this layer now.

#### Layer 2 — Core plumbing **[SURVIVES] / [PARTIAL]**

- **[SURVIVES]** `StepResult.reasoning?` — add the field (`core/types.ts:48`).
  This is the single chokepoint: all three adapters funnel through one
  `runAgentLoop`, so once reasoning is on the step, the source is unified.
- **[PARTIAL]** `agent-loop.ts:322` — capture `response.reasoning`, emit the
  step. Shape survives; how reasoning is read simplifies post-migration.
- **[PARTIAL]** Thread a `reasoning` option through CLI → config → Agent →
  loop → `ChatOptions`. Post-migration this becomes "flip pi-ai's flag" —
  the CLI/settings plumbing survives, the provider-option shape does not.

#### Layer 3 — TUI **[SURVIVES]**

Fully migration-agnostic (cannot be done in isolation — needs a reasoning
step to render — so it ships with the post-migration pass):
- `FeedEntry` gains `reasoning?` on `AssistantMessageEntry`
  (`tui/types.ts:19`) or a new `reasoning` kind.
- New `ReasoningBlock` component — clone `ToolCallBlock`'s collapsed/expand
  pattern (`tool-call-block.tsx:54`).
- `use-agent.ts:128` `onStep` — handle the reasoning step, commit alongside
  the assistant message.
- `app.tsx` — `/thinking` toggle (mirrors `/models` dispatch at
  `app.tsx:224`); footer `contextTokens` accounts for reasoning tokens.

### Adapter parity (NOT in the original File estimate)

The original estimate is CLI-only. All three adapters must reach parity, and
each has its own serialization boundary that currently drops reasoning. The
gaps, tagged by relevance:

#### SDK **[SURVIVES]**

| Surface | Gap |
|---------|-----|
| `generateText().steps` | **Free** — raw `StepResult[]` flows through (`sdk/index.ts:179`) |
| `streamText` `stepsStream` | **Free** — `stream.enqueueStep(step)` passes the full step (`sdk/index.ts:273`) |
| `onReasoning` callback | Add for ergonomic parity (else users walk `onStep`) |
| `AgentResponse` | `agent.chat()` returns `{ text, toolCalls, usage }` — **no reasoning** (`sdk/agent.ts:213`). Add `reasoning?` |

#### Server **[SURVIVES]** — the worst offender

The ARCHITECTURE doc already flags this for metadata ("the server forwards
only a narrow `{type, content, timestamp}` step subset"). Reasoning hits that
wall three times:

| Surface | Gap |
|---------|-----|
| `server-core.ts:131` onStep | Branches on `text` + `tool_call` only — reasoning ignored. Add an `onReasoning` passthrough |
| REST response shape | `{ text, usage, finishReason }` — no reasoning |
| SSE (`toSSEStream`) | Shares `StreamManager` with SDK — a single `reasoning` event here covers **both** adapters (`stream-manager.ts:190`) |
| **WebSocket** `ws-handlers.ts:296` | **Worst case**: collapses every non-text step to `{ type: "progress", activity: step.content ?? step.type }` — reasoning becomes a progress msg with `activity: "reasoning"` and undefined content. Needs a dedicated `{ type: "reasoning", ... }` message type |

The WS layer is the real parity liability: even with a perfect provider +
loop + SDK, reasoning is invisible to WS clients without a protocol addition.

#### Shared `StreamManager` **[SURVIVES]**

`toSSEStream()` emits `text`/`tool_call`/`tool_result`/`done` only
(`stream-manager.ts:190`). One `reasoning` event addition covers both the SDK
and Server SSE paths.

### Streaming vs block design question **[PARTIAL]**

Decides the scope. Does reasoning **stream** (token-by-token, like
`text_delta`) or arrive **as a block** on completion?

- The Risks section above already punts streaming ("Deferred — for v1, show
  reasoning on completion").
- pi-ai streams reasoning natively as part of its normalized event flow, so
  the streaming path is cheap post-migration.
- Against the hand-rolled provider, streaming adds a `reasoning_delta` to
  `StreamDelta` and **6 touch points** (loop → `StreamManager` → SDK
  `onReasoning` → server SSE → server WS → TUI live region). Block-only is
  ~4 adapter changes.

**Recommendation: ship block-only first (4 changes), add streaming in a
follow-up post-migration** when pi-ai makes it ~trivial. Doing streaming now
against the hand-rolled provider risks designing the `reasoning_delta` shape
wrong against a detail pi-ai will obsolete.

### Post-migration implementation checklist (~1 PR)

When the pi-ai migration lands, T052 becomes:
1. **[SURVIVES]** `StepResult` ← add `reasoning?: string` (`core/types.ts:48`)
2. **[PARTIAL]** Agent loop ← pass pi-ai's `reasoning: { enabled: thinkingFlag }`;
   emit reasoning into the text step (~5 lines)
3. **[SURVIVES]** `FeedEntry` ← `reasoning?` on `AssistantMessageEntry` (`tui/types.ts:19`)
4. **[SURVIVES]** `ReasoningBlock` component ← clone `ToolCallBlock`'s collapsed/expand pattern (`tool-call-block.tsx:54`)
5. **[SURVIVES]** `use-agent.ts:128` `onStep` ← commit reasoning alongside assistant text
6. **[SURVIVES]** `app.tsx` ← `/thinking` toggle + flag (mirrors `/models` dispatch at `app.tsx:224`); footer `contextTokens` accounts for reasoning tokens
7. **[SURVIVES]** SDK ← add `AgentResponse.reasoning?` (`sdk/agent.ts:213`) + optional `onReasoning` callback
8. **[SURVIVES]** `StreamManager.toSSEStream()` ← add a `reasoning` event (covers SDK + Server SSE; `stream-manager.ts:190`)
9. **[SURVIVES]** Server ← `server-core.ts:131` `onReasoning` passthrough + REST shape field
10. **[SURVIVES]** WS ← new `{ type: "reasoning", ... }` message type (`ws-handlers.ts:296`)
11. **[THROWAWAY pre-migration]** Apply the pi-ai thinking claim correction to `docs/llm-provider-management-comparison.md` §2.7

---

## T049 — Session Selector Overlay

### Problem
The TUI has no session management. The conversation is in-memory; if the user
restarts Seepient Agent, the conversation is lost. There's no way to list, preview,
resume, or export past sessions.

### Target UX
A session-selector overlay (accessible via `/sessions` or palette → "sessions")
that lists saved sessions with:
- Timestamps (created / last updated).
- First message (preview).
- Fuzzy search to filter.
- Enter to resume (loads the session into the agent).
- Delete / rename / export actions.

### Scope
1. **Session persistence for the CLI Agent**: The CLI Agent currently has no
   persistence. The SDK Agent does (`opts.persist` → PersistenceBackend). The
   CLI Agent needs:
   - A `PersistenceBackend` (file backend — `~/.seepient/sessions/<id>.json`).
   - Auto-save after each turn (like the SDK's `persistMessages()`).
   - Auto-load on startup (resume the last session or start fresh).

2. **Session listing**: A function that lists saved sessions (from the backend's
   `list()` + `load()` for metadata). Returns `{ id, createdAt, updatedAt,
   preview }`.

3. **SessionSelector overlay**: A bordered list of sessions with:
   - ↑/↓ navigate.
   - Fuzzy search (reuse `fuzzyFilter`).
   - Enter → resume (load messages into the agent + close overlay).
   - `d` → delete (confirm + delete from backend).
   - `e` → export (write to a file).

4. **Wiring**:
   - startTui: create a PersistenceBackend + pass to the Agent (or use-agent).
   - use-agent: auto-save after each chat() completes.
   - app.tsx: `/sessions` command → open overlay.

### File estimate
| File | Change | ~Lines |
|------|--------|--------|
| `src/adapters/cli/agent.ts` | Add persist option + auto-save/load | ~60 |
| `src/adapters/cli/tui/overlays/session-selector.tsx` (new) | List/search/resume/delete | ~100 |
| `src/adapters/cli/tui/hooks/use-agent.ts` | Auto-save after chat | ~15 |
| `src/adapters/cli/tui/app.tsx` | `/sessions` command + overlay render | ~20 |
| `src/adapters/cli/tui/index.tsx` (startTui) | Create backend + pass | ~15 |
| **Total** | | **~210** |

### Risks
- **Agent state coupling**: The CLI Agent holds messages as instance state. To
  resume a session, the agent's messages must be replaceable (setMessages —
  exists). But: the agent also has middleware, system prompt, etc. that are set
  at construction. Resuming a session means loading the old messages + keeping
  the current provider/middleware/system. Clean if the session stores only
  messages (SessionData).
- **Concurrent sessions**: Only one session active at a time (the TUI is
  single-session). No concurrency issues.
- **Session file format**: Use `SessionData` (id, messages, createdAt, updatedAt,
  provider, model). The file backend already handles this shape.

### Prerequisites
- None blocking — can be implemented independently. The CLI Agent's persistence
  is the main new plumbing.

---

## Polish Phase (Phase 7 — T055-T059)

### T055 — CI Assertion (DONE)
Already shipped with the first TUI commit (`.github/workflows/ci.yml`).

### T056 — Ink Render Tests
Add `ink-testing-library` render tests for core components (message-area,
tool-call-block, prompt-area, GoalStatus, settings editor). ~50-80 lines. No
production changes.

### T057 — Full `pnpm test` Suite
Already passing (262 tests across 20 files). Stays green as features land.

### T058 — VitePress Docs Update
Document TUI launch behavior, keybindings, slash commands, settings editor,
model selector, todo panel, file-watcher, markdown, expand/collapse.
~200-300 lines of markdown.

### T059 — Spec Acceptance Scenarios
Run the spec.md acceptance scenarios for each completed user story.

---

## Priority Recommendation

1. **T051 (Diff Viewer + Safe Write)** — highest value. File corruption is a
   real risk with the current blind overwrite. The safe write (atomic + old
   capture) should be implemented regardless of the diff viewer.
2. **T049 (Session Selector)** — high value. Users lose everything on restart.
3. **T052 (Thinking Blocks)** — provider-dependent. Lower priority unless the
   user actively uses reasoning models.

---

## Architecture Notes

- All deferred items are **additive** — they don't break existing flows.
- Each can be implemented independently (no cross-dependencies).
- The TUI architecture (use-agent, use-feed, overlays, app.tsx wiring) is
  stable. New overlays follow the existing pattern (bordered overlay +
  handleUserInput intercept + app.tsx render).
- The command-handler refactor (return `{ output, exit }`) means any new slash
  command is trivially dispatchable from both readline and TUI.
- The `ToolResult` interface already has `metadata?: Record<string, unknown>` —
  the safe-write metadata pass-through reuses this existing field (the factory
  handler just needs to return a ToolResult instead of a string when metadata
  is present).
