# Research: TUI Parity & Generative Widget Upgrade

**Phase 0 output.** Resolves every technical unknown referenced in `spec.md` and `plan.md`. Every claim about omp is grounded in the cloned source at `/tmp/omp-eval` (read during evaluation); every claim about Seepient is grounded in this repo's source.

## Method

omp was shallow-cloned to `/tmp/omp-eval` and read directly. The two packages analyzed:

- `packages/tui/` — `pi-tui`, omp's hand-built terminal UI framework (14 components + 3,901-line core engine `tui.ts`).
- `packages/coding-agent/src/modes/` — omp's interactive chat surface (62,975 lines across `interactive-mode.ts`, 7 controllers, 40+ components).
- `packages/hashline/` — omp's hash-anchored patch language and applier.

Seepient source read for current state: `src/adapters/cli/tui/{app.tsx, hooks/use-agent.ts, components/*}`, `ARCHITECTURE.md`, prior specs `001/003/005/006`.

---

## R1 — Renderer architecture decision (resolves ARCH-1)

### Finding

omp's `pi-tui` (`packages/tui/src/tui.ts`, 3,901 lines) is a custom differential renderer with these load-bearing properties:

1. **Reference-equality memoization.** A component's `render(width)` returns `readonly string[]`. Returning the same array reference is the engine's proof of byte-identical content; containers memoize their concatenation on it. The TUI derives each frame's stable prefix from this equality.
2. **CSI 2026 synchronized output.** Each paint is wrapped in `\x1b[?2026h … \x1b[?2026l` so the terminal applies the frame atomically. This is the primary flicker-killer. Ink does **not** emit CSI 2026.
3. **Append-only scrollback contract.** Rows committed to native scrollback are immutable; a `NativeScrollbackLiveRegion` marks commit boundaries. The engine never probes scroll position; ED3 (`CSI 3 J`) is emitted only for gesture-driven replays (session replace, resize, resetDisplay).
4. **Autowrap discipline.** Autowrap disabled (`\x1b[?7l`) during paint, explicit CRLFs emitted, autowrap re-enabled — prevents "staircase trails" on exact-width rows.

Seepient uses **Ink** (React reconciler → Yoga flexbox → `log-update`-style line diff). Ink does **not** emit CSI 2026; its render model writes a diff via cursor movement + erase. The `ink-reset.ts` file pokes Ink's internal `instances.js` to reset `fullStaticOutput`/`lastOutput` before a `<Static>` remount — a pragmatic workaround that works but depends on Ink internals (fragility risk, audited in T0/QW-4).

### Decision

**Do NOT port omp's renderer in this spec. Stay on Ink.** Apply throttling (R2), memoization (R3), and cursor hide (R4) to drive flicker to "virtually imperceptible" within Ink's model. Re-evaluate after Phase 1–3 ship.

### Rationale

- **Cost.** A faithful port is ~4,000 lines (the engine alone) plus rewriting every Zoe component against the `Component.render(width): readonly string[]` interface. That's a multi-week effort that produces no new *capability* — only polish.
- **005 lesson.** Prior spec `005-fullscreen-tui` took alt-buffer control and **reverted**: Ink has no native mouse, alt-buffer loses native scrollback, and the result was "mouse-capture gibberish." Any renderer change that touches the buffer/scrollback model carries this risk. The `<Static>` + native-scrollback model (what 003/006 shipped on) is retained.
- **Diminishing returns at low frequency.** The flicker problem is acute only during high-frequency token streaming. T1 widgets and T4 components are low-frequency (user-paced renders), where Ink is fine. R2's throttle attacks the acute case directly.
- **Reversibility.** If R2–R4 prove insufficient, a future spec can port `pi-tui`. Nothing in Phases 1–4 forecloses that.

### Alternatives considered

| Alternative | Rejected because |
|---|---|
| Port `pi-tui` wholesale now | Cost vs. benefit (above); 005 lesson |
| Hybrid: keep Ink for layout, custom-render the streaming region | Two renderers in one app; they fight over stdout; complexity worse than either pure approach |
| Adopt `@vadimdemedes/ink` v5+ "experimental concurrent mode" | Does not add CSI 2026; does not solve the root cause |

---

## R2 — Throttled streaming flush (resolves QW-1 mechanism)

### Finding

`src/adapters/cli/tui/hooks/use-agent.ts:60` calls `setStreamingText(streamingTextRef.current)` inside the `onStep` handler on every `text_delta`. At 100 tok/s this triggers 100 React renders/sec. Ink's reconciler then writes 100 partial-frame line diffs/sec, each visible as a flicker.

### Decision

Buffer tokens in a ref; flush to state on a ~33ms interval (≈30fps); clear the interval on commit/abort.

### Mechanism (sketch — implementation in tasks)

```ts
// in useAgent
const flushTimerRef = useRef<NodeJS.Timeout | null>(null);
const scheduleFlush = useCallback(() => {
  if (flushTimerRef.current) return;
  flushTimerRef.current = setTimeout(() => {
    flushTimerRef.current = null;
    setStreamingText(streamingTextRef.current);
  }, 33); // ~30fps
}, []);

// in onStep text_delta branch:
streamingTextRef.current += step.content;
scheduleFlush();           // throttle the render
// commit/abort/finally: clear timeout, flush synchronously
```

A streaming tool output (`tool_progress`) gets the same treatment via `streamingToolRef`.

### Why ~30fps

- Below ~24fps the crawl looks laggy. Above ~60fps the terminal can't paint between Ink writes, so extra frames are wasted (and re-introduce flicker).
- omp's render scheduler (`DEFAULT_RENDER_SCHEDULER`) coalesces similarly; 30–60fps is the established band.

---

## R3 — React.memo strategy (resolves QW-3)

### Finding

During a turn, every `setStreamingText` re-renders `TuiApp`, which re-renders every child including frozen `<Static>` history rows. Ink's `<Static>` memoizes by index, but the row components themselves (`AssistantMessage`, `ToolCallBlock`, etc.) re-render unless memoized.

### Decision

`React.memo` on: `AssistantMessage`, `ToolCallBlock`, `UserMessage`, `InfoMessage`, `ErrorMessage`, `GoalStatus`, `LogoBanner`, `DiffViewer`. Feed entries are immutable once appended, so shallow-prop memo is safe.

### Rationale

- The props for a frozen feed entry never change after append. `React.memo` with default shallow compare is correct and sufficient.
- This is the single highest-leverage rendering fix after R2.

---

## R4 — Cursor hide (resolves QW-2)

### Finding

During rapid redraws the hardware cursor jumps across rows, perceived as flicker. omp hides it (`\x1b[?25l`) for every paint and restores (`\x1b[?25h`) when leaving.

### Decision

Emit `\x1b[?25l` when `isRunning && !pendingPermission`; restore `\x1b[?25h` otherwise. Implement in a small `useEffect` in `TuiApp` keyed on those flags. Write directly to `process.stdout` (Ink doesn't own the cursor for this purpose).

---

## R5 — `ink-reset.ts` audit (resolves QW-4)

### Finding

`src/adapters/cli/tui/ink-reset.ts` (59 lines) reaches into Ink's `instances.js` to reset `fullStaticOutput`/`lastOutput` before a `<Static>` remount (resize/expand/session-resume). This depends on undocumented Ink internals.

### Decision

Audit and harden: (1) document the exact Ink version and internal symbols it depends on; (2) add a version-drift guard that logs a warning (not throws) if the Ink internals shape changes; (3) wrap in try/catch so a failure degrades to " artifacts on resize" rather than a crash. No behavioral change in the happy path.

---

## R6 — Generative widget protocol (resolves T1 design)

### Finding

omp already ships a widget/component host system in `packages/coding-agent/src/extensibility/extensions/types.ts`:

```ts
export type ExtensionUiComponent = Component & { dispose?(): void };
export type ExtensionUiComponentFactory = (tui: TUI, theme: Theme) => ExtensionUiComponent;
export type ExtensionWidgetContent = string[] | ExtensionUiComponentFactory | undefined;

export interface ExtensionUIContext {
  setWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void;
  setFooter(factory: ExtensionUiComponentFactory | undefined): void;
  setHeader(factory: ExtensionUiComponentFactory | undefined): void;
  custom<T>(factory: (tui, theme, keybindings, done) => ExtensionUiComponent, options?): Promise<T>;
  select/confirm/input/notify/setStatus/setEditorText/…
}
```

Crucially, omp's widgets are **code-authored at extension registration time**, not LLM-authored mid-conversation. The Seepient innovation is the latter.

### Decision — L1 declarative palette, no model-emitted code

The LLM emits structured data via a `render_widget` tool call. The TUI maps `kind` → built-in renderer. Widget actions are opaque IDs; activating one dispatches a `widget_action` synthetic user turn.

**Why not code (L3)**: sandbox hell (file access, `process.exit`, infinite loops, memory blowup), the model is bad at it, and L1 covers ~90% of value. omp's own widgets avoid the issue by being author-trusted code. For LLM output, declarative is the only safe choice (mirrors Slack Block Kit, MS Adaptive Cards, Telegram inline keyboards, Vercel Generative UI's server-component variant).

**Why not a nestable layout DSL (L2) now**: more flexible but requires a parser, validation, and focus-management for arbitrary nesting. Defer until L1 surfaces real needs.

### Palette (L1)

| `kind` | props | interactive? |
|---|---|---|
| `table` | `{columns, rows}` | no (display) |
| `keyvalue` | `{entries: [{label, value}]}` | no |
| `chart` | `{variant: "bar"\|"line"\|"sparkline", data, labels?}` | no |
| `tree` | `{root: {label, children?}}` | expand/collapse (keyboard) |
| `panel` | `{body: string \| string[], accent?}` | no |
| `diff` | `{oldContent, newContent, path?}` | no (reuses `DiffViewer`) |
| `form` | `{fields: [{id, label, type, placeholder?}], submitLabel?}` | yes — returns `{fieldId: value}` |
| `product_card` | `{title, subtitle?, price?, rating?, imageRef?, actions: [{id, label, style?}]}` | yes — returns `{actionId}` |
| `status_grid` | `{items: [{label, status: "ok"\|"warn"\|"fail"\|"pending"}]}` | no |

`actions[]` appears on any kind: `[{id, label, style?: "primary"\|"secondary"\|"danger"}]`. Activating an action emits `widget_action`.

### Round-trip contract

1. LLM calls `render_widget({id, kind, title?, props, actions?})`.
2. TUI mounts a `ChatBlock` (R7) with the rendered component; if `actions` or interactive kind, it stays in the live region.
3. User activates an element → TUI calls `onAction(widgetId, actionId, state?)`.
4. The widget host dispatches a synthetic user message: `[widget:\<widgetId\>] action "\<actionId\>" state {...}` and submits it as a new turn.
5. The agent receives it as a normal user message; the loop continues.

The LLM **never** executes. The harness mediates. This is the load-bearing safety property.

---

## R7 — ChatBlock lifecycle primitive (resolves T4-1)

### Finding

omp's `packages/coding-agent/src/modes/components/chat-block.ts` (111 lines) is the keystone primitive. It's a `Container` subclass with:

- `onMount()` / `onCleanup(cleanup)` — lifecycle hooks à la `useEffect`.
- `mount()` / `finish()` / `dispose()` — `finish` = self-complete (stop animation, keep final frame in transcript); `dispose` = host discard (transcript reset).
- `isTranscriptBlockFinalized()` — `false` while mounted+unfinished, `true` after `finish`/`dispose`. The `TranscriptContainer` uses this to decide live-region vs frozen-scrollback.

Seepient's current analog is rough: `use-agent.ts` keeps `streamingText`/`streamingTool` outside `<Static>` and commits them to the feed on completion. This works for text/tool-output but doesn't generalize to widgets, thinking indicators, or animations.

### Decision

Port the `ChatBlock` model to Seepient's React/Ink world as a typed primitive. Adaptation:

- omp's `ChatBlock extends Container` (imperative). Seepient's is a React-friendly abstraction: a `ChatBlock` is a feed entry with `{id, kind: 'block', finalized: boolean, render: () => ReactElement, onCleanup?: () => void}`.
- `useFeed` gains a `mountBlock(block)` / `updateBlock(id, patch)` / `finalizeBlock(id)` / `disposeBlock(id)` API.
- `<MessageArea>` renders blocks: unfinalized ones in the live region (re-renderable), finalized ones committed to `<Static>` history.
- On session resume, finalized blocks are re-derived from persisted messages (`feed-serializer.ts`); unfinalized ones are disposed (they were transient).

This is the keystone because T1 widgets, the thinking indicator (T4-3), and live tool blocks all mount through it.

---

## R8 — Hashline format and adoption (resolves T3)

### Finding

omp's `packages/hashline/` is a line-anchored patch language. Format (from its README + `src/prompt.md`):

```
[hello.ts#a1b2]
SWAP 1.=1:
+const greeting = "hello";
```

- `[PATH#TAG]` — section header; TAG is a 4-hex content hash from a `SnapshotStore`.
- Operations: `SWAP A.=B:` (replace lines A–B), `SWAP.BLK A:` (replace syntactic block at A), `DEL A.=B` / `DEL.BLK A`, `INS.PRE A:` / `INS.POST A:` / `INS.HEAD:` / `INS.TAIL:`, `MV DEST`, `REM`.
- `+TEXT` body rows (literal lines).
- On apply: resolve tag → verify live file hash matches → reject on mismatch, or **3-way-merge** onto current content for session-aware recovery.

`Filesystem`-abstracted (`InMemoryFilesystem`, `NodeFilesystem`; subclass for VFS/S3/LSP/Git). `SnapshotStore` records pre-edit content hashes per path.

omp's claimed impact (from README): "Grok Code Fast 1: 6.7% → 68.3%", "Grok 4 Fast: −61% tokens", "MiniMax: 2.1× pass rate." Whether these exact numbers hold for Seepient's models, the structural argument (smaller payload, fewer reproduction errors) is sound.

### Decision — adopt a hashline-style tool, keep whole-file as fallback

- New tool `edit_file` (or `hashline_edit`) accepting a patch string + a `snapshotStoreId`.
- The CLI maintains a `SnapshotStore` recording file hashes when `read_file`/`write_file`/`edit_file` observe them.
- On apply: hash verify → reject (stale-anchor) or 3-way-merge.
- On success: emit `FileWriteMetadata` (per 006 contract) so the existing `DiffViewer` renders the change. The diff is now **anchored**, not post-hoc.
- `write_file` (whole-file) is **retained** as a fallback for new files and for models that don't support the patch format.

### Adoption scope

- Implement the patcher as a self-contained module under `src/core/hashline/` (not `src/tools/`) so it's reusable by SDK/Server adapters later.
- Single source of truth (AGENTS.md): one patcher, used by all adapters.

### Alternatives considered

| Alternative | Rejected because |
|---|---|
| `apply_patch` (opaque full-file patch) | No content-hash anchor; stale-edit detection is weaker |
| `str_replace` (Aider-style) | No hash anchor; ambiguous on repeated matches; omp's benchmarks beat it |
| Keep whole-file `write_file` only | High token cost; "model dropped lines" failures; the gap this spec closes |

---

## R9 — Streaming diff stabilization (resolves T2 commit gating)

### Finding

omp's `tool-execution.ts` includes `stripTrailingUnbalancedRemoval()`: while a diff streams, trailing `-old` / `@@hunk` lines appear before matching `+new` lines arrive. Without stabilization, the preview shows "removals first, additions catching up" jitter.

omp's `assistant-message.ts` also includes `detectLiveReflowingMarkdown()`: while markdown streams, an open ` ```mermaid ` fence or a GFM table mid-arrival is **held out of native scrollback** until layout is stable.

### Decision

Port both as utilities used by the streaming commit path:

- `stripTrailingUnbalancedRemoval(diff)` — applied to streaming `edit_file` previews before commit.
- `isLiveReflowingMarkdown(text)` — gates when a streaming assistant text block may commit to `<Static>` (in the `ChatBlock` model from R7).

---

## R10 — Component parity inventory (resolves T4)

### omp pi-tui base (14 components, line counts from source)

| Component | Lines | Zoe state | T4 action |
|---|---|---|---|
| `editor` | 3,092 | ❌ single-line only | **defer** (needs renderer, R1) |
| `markdown` | 2,068 | ◐ thin wrapper | T2 (enrich) |
| `settings-list` | 793 | ✅ `SettingsEditor` | none |
| `select-list` | 531 | ✅ `CommandPalette`, `SessionSelector` | none |
| `input` | 474 | ✅ `TextInput` + `PromptArea` | none |
| `image` | 444 | ❌ none | **defer** (needs renderer + Kitty graphics) |
| `tab-bar` | 300 | ❌ none | T4 build |
| `scroll-view` | 227 | ◐ native scrollback | none (model retained) |
| `box` | 194 | ✅ Ink `<Box>` | none |
| `text` | 122 | ✅ Ink `<Text>` | none |
| `loader` | 103 | ◐ `ink-spinner` | T4 (cancellable variant) |
| `truncated-text` | 69 | ◐ inline `truncate()` | T4 (extract helper) |
| `cancellable-loader` | 40 | ❌ none | T4 (compose from loader) |
| `spacer` | 32 | ✅ `<Box flexGrow>` | none |

### omp surface (selected, from `modes/components/` — 70 files total)

| Component | Lines | Zoe state | T4 action |
|---|---|---|---|
| `tool-execution` | 1,288 | ◐ `ToolCallBlock` (105) | T2 (streaming stabilization) |
| `assistant-message` | 817 | ◐ `AssistantMessage` (15) | T4 (thinking indicator) |
| `transcript-container` | 806 | ◐ `MessageArea` (69) + `<Static>` | none (model retained) |
| `chat-block` | 111 | ❌ none | **T4-1 (keystone, R7)** |
| `plan-review-overlay` | 847 | ❌ none | T4 (plan mode foundation) |
| `custom-editor` | 835 | ❌ none | **defer** (extension-widget host is the analog; T1 covers LLM use) |
| `agent-dashboard` | 1,183 | ❌ none | T4 later |
| `welcome` | 579 | ✅ `LogoBanner` | none |
| `footer` | 276 | ✅ `Footer` (52) | none |
| `diff` | 254 | ✅ `DiffViewer` (119) | none |

### Zoe TUI current state (full inventory, from source)

```
app.tsx (452), index.tsx (256), ink-reset.ts (59), theme.ts (38), layout.ts (15),
feed-serializer.ts (77), session-export.ts (66), file-index.ts (40), types.ts (69)
components/:
  assistant-message (15), autocomplete (108), command-palette (77), diff-viewer (119),
  error-message (14), footer (52), goal-status (40), info-message (13), logo-banner (50),
  markdown (117), message-area (69), permission-prompt (51), prompt-area (108),
  text-input (155), tool-call-block (105), user-message (14)
overlays/:
  help-dialog (37), model-selector (75), session-selector (217), settings-overlay (171)
hooks/:
  use-agent (232), use-feed (39), use-file-watcher (41), use-keybindings (31), use-theme (14)
diff/:
  file-write-meta (23), line-diff (49)
logo/:
  gradient (39)
```

### T4 prioritized build list

| ID | Component | Effort | Unlocks | Depends on |
|---|---|---|---|---|
| T4-1 | `ChatBlock` lifecycle primitive | medium | T1, T4-3, live tool blocks | — |
| T4-2 | Widget host controller (port `ExtensionUIContext` subset: `setWidget`, `custom`) | medium | T1 | T4-1 |
| T4-3 | Streaming thinking indicator (eased starburst + speed tracker) | small | polish | R2 (throttle) |
| T4-4 | `TabBar` | small | multi-pane | — |
| T4-5 | `plan-review-overlay` | medium | plan mode | T4-1 |
| T4-6 | `TruncatedText` helper (width-aware) | small | cleaner tool blocks | — |
| T4-7 | `notify()` toast (non-feed flash) | small | non-feed alerts | T4-1 |
| T4-8 | `agent-dashboard` | large | depth | later |
| T4-9 | Refactor: extract `input-controller` + `event-controller` hooks from `app.tsx` | medium | maintainability | after T1 lands |

**Deferred (needs renderer, R1):** `editor` (multiline), full `markdown` (LaTeX/mermaid), `image` (Kitty graphics), `custom-editor`.

---

## R11 — Interaction model: keyboard-first, mouse optional

### Finding

omp enables mouse tracking (`?1000h ?1003h ?1006h`) only for fullscreen overlays; the live region keeps native text selection. 005's lesson: mouse capture in the live region causes gibberish because Ink has no native mouse event model.

### Decision

Widgets are **keyboard-first**: focus navigation (Tab/↑↓), Enter to activate. Mouse clicks supported **only inside an overlay** (existing overlay behavior). The live widget region does not capture mouse. This is consistent with 005's lesson and avoids the gibberish failure mode.

---

## Summary of resolved decisions

| Unknown | Resolution |
|---|---|
| ARCH-1 renderer fork | **Stay on Ink.** Throttle + memo + cursor hide. Re-evaluate post-Phase-3. |
| Streaming flicker | R2: 30fps ref-buffer flush. R3: `React.memo`. R4: cursor hide. |
| `ink-reset` fragility | R5: audit + version-drift guard + try/catch. |
| Generative widget execution | R6: L1 declarative palette; no L3 model code. |
| Widget lifecycle | R7: port `ChatBlock` model to React/Ink. |
| Edit system | R8: adopt hashline-style anchored patches; keep `write_file` fallback. |
| Streaming polish | R9: port `stripTrailingUnbalancedRemoval` + `isLiveReflowingMarkdown`. |
| Component parity | R10: T4-1..9 prioritized; needs-renderer items deferred. |
| Interaction model | R11: keyboard-first; mouse in overlays only (005 lesson). |

No `NEEDS CLARIFICATION` remains.
