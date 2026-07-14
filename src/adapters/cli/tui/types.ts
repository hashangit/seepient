/**
 * TUI feed types — the discriminated union of feed entries.
 *
 * `use-feed` holds an array of `FeedEntry`; each `kind` maps to a render
 * component. Entries are immutable once complete (so Ink's `<Static>` can
 * render history efficiently); only the currently-streaming entry mutates.
 *
 * The shapes derive from Core's `StepResult` (text / tool_call) plus the
 * adapter-level concerns the readline REPL handles inline: user input,
 * permission approval, and errors.
 */

export interface UserMessageEntry {
  id: string;
  kind: 'user';
  content: string;
}

export interface AssistantMessageEntry {
  id: string;
  kind: 'assistant';
  content: string;
}

export interface ToolCallEntry {
  id: string;
  kind: 'tool';
  name: string;
  args: Record<string, unknown>;
  status: 'running' | 'ok' | 'fail';
  output?: string;
  durationMs?: number;
  /** Tool-specific structured payload (e.g. write_file's FileWriteMetadata)
   *  for richer rendering. Opaque here; parsed at the component boundary. */
  metadata?: unknown;
}

export interface ErrorEntry {
  id: string;
  kind: 'error';
  message: string;
}

export interface InfoEntry {
  id: string;
  kind: 'info';
  content: string;
}

export interface LogoEntry {
  id: string;
  kind: 'logo';
}

/** T4-1 — Lifecycle-managed block entry.
 *
 * A block renders a React element, can update while unfinalized, and freezes
 * on finalize. Used by widgets, thinking indicators, live tool blocks, and
 * custom components. See `contracts/feed-lifecycle.md`. */
export interface BlockEntry {
  id: string;
  kind: 'block';
  blockKind: 'widget' | 'thinking' | 'live-tool' | 'custom';
  props: unknown;
  finalized: boolean;
}

export type FeedEntry =
  | UserMessageEntry
  | AssistantMessageEntry
  | ToolCallEntry
  | ErrorEntry
  | InfoEntry
  | LogoEntry
  | BlockEntry;

// `Omit<FeedEntry, 'id'>` collapses the union (it omits from the merged shape,
// losing each kind's fields). This distributes Omit per member so callers can
// pass `{ kind: 'tool', name, args, ... }` and get the right narrow type.
type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;

/** A feed entry without its generated id — the input shape for `appendEntry`. */
export type FeedEntryInput = DistributiveOmit<FeedEntry, 'id'>;
