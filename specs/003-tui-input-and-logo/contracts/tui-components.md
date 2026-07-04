# Contract: TUI Components & Live-Region Composition

**Feature**: `003-tui-input-and-logo` | **Layer**: CLI adapter / presentation

UI contract: the props each new/changed component exposes and the required
ordering of the live region. No external/network API surface.

> **Deferred**: the persistent compact wordmark (`TopBar`) is **not** built this
> round. Only `InputBox` and `LogoBanner` are contracted here.

---

## C1. `InputBox` — bordered, always-on prompt

**File**: `src/adapters/cli/tui/components/input-box.tsx` (NEW)

```ts
interface InputBoxProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  /** true → render dimmed and ignore ALL keystrokes. Composed by app.tsx from
   *  isRunning || overlay !== null || !!pendingPermission. */
  disabled: boolean;
  onHistoryUp?: () => void;
  onHistoryDown?: () => void;
  commands: Suggestion[];
  skills: Suggestion[];
}
```

**Behavior**:
- Rounded box (`╭─╮` / `│` / `╰─╯`) at `min(stdout.columns, MAX) -
  2*HORIZONTAL_PADDING`; recompute on resize (`useStdout`).
- Inside: the existing `PromptArea` input row. Input logic (autocomplete, `/`+`@`,
  history ↑/↓) is reused unchanged.
- `disabled === true`: border + text render in `theme.fgDim`; passes
  `enabled={false}` to `PromptArea`→`TextInput` so its `useInput` early-returns
  (no keystroke capture — preserves the overlays' exclusive-stdin contract).
- `disabled === false`: live input, colors as today.
- Multi-line input grows the box; bottom border closes around N rows.

**Consumed by**: `app.tsx` (single render site).

---

## C2. `LogoBanner` — large welcome banner (a feed entry)

**File**: `src/adapters/cli/tui/components/logo-banner.tsx` (NEW)

```ts
// No props. The large ASCII grid + palette are module constants.
export function LogoBanner(): JSX.Element;
```

**Rendered through a feed entry, not a special-case element** (FR-005):
- Add `kind: 'logo'` to the `FeedEntry` union in `src/adapters/cli/tui/types.ts`.
- Add a `case 'logo': return <LogoBanner/>;` to `FeedItem` in
  `src/adapters/cli/tui/components/message-area.tsx`.
- `app.tsx`/`useFeed` seeds **one** `{ id: '__logo__', kind: 'logo' }` entry at
  session start, before any messages. It then scrolls away with the feed via the
  existing single `<Static>` — no second `<Static>`, no `as any`.

**Behavior**: renders the large multi-line ASCII "Seepient Agent" with the 45° HSL
rainbow gradient; width-capped like every other feed item (stays `< columns`).

---

## C3. `app.tsx` live-region composition (MODIFY)

The input is **always** the last live element; overlays/spinner render above it.
Top → bottom (within the live region):

```
<MessageArea/> (<Static> feed; one kind:'logo' entry seeded at start)
{latestTodos ? <GoalStatus/>}
{streamingText ? <AssistantMessage/>}
{streamingTool ? <ToolCallBlock/>}
{ ── live slot (mutually exclusive) ──:
    overlay==='palette' ? <CommandPalette/>
    : overlay==='help'    ? <HelpDialog/>
    : overlay==='model'   ? <ModelSelector/>
    : overlay==='settings'? <SettingsEditor/>
    : pendingPermission   ? <PermissionPrompt/>
    : (isRunning && !streamingText) ? <Spinner "Seepient is working"/>
    : null
}
<InputBox disabled={isRunning || overlay !== null || !!pendingPermission} …/>
{changedFile ? <Text>…}
<Footer/>
```

**Invariants**:
- `<InputBox/>` renders **unconditionally** (no longer a mutually-exclusive branch).
- `disabled` is the **composite** `isRunning || overlay !== null ||
  !!pendingPermission` — so an open overlay/palette keeps exclusive stdin (its
  `useInput` is the only live handler; `InputBox`'s early-returns).
- The spinner renders in the live slot **above** the box, never instead of it.
- The logo entry is seeded once at session start (C2); it scrolls with the feed.

---

## C4. `TextInput` extension (MODIFY)

**File**: `src/adapters/cli/tui/components/text-input.tsx`

Add optional `enabled` prop (default `true`). When `false`, `useInput`
early-returns (no keystrokes) and rendered text uses `theme.fgDim`. Single
mechanism powering `InputBox.disabled`. No other input logic changes. `PromptArea`
forwards `enabled` to `TextInput`.

---

## Ownership & boundaries

- One owner per component (new files under `tui/components/` and `tui/logo/`).
- `FeedEntry`/`FeedItem` own the `kind: 'logo'` variant (`tui/types.ts`,
  `message-area.tsx`).
- The gradient owns color math (`tui/logo/gradient.ts`); components only consume.
  No inline hex anywhere.
- `app.tsx` is the only composer; nothing else imports `InputBox`/`LogoBanner`.
- All new code is presentation-layer (CLI adapter) importing only `theme.ts` +
  core types — no reach into core/engine/infra.
