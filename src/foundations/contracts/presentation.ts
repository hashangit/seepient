/**
 * Presentation contracts — the vocabulary shared by tool producers
 * (Capabilities) and renderers (UI). Owned by Foundations so neither side
 * imports the other: both speak to the contract.
 */

export type WidgetKind =
  | 'table' | 'keyvalue' | 'chart' | 'tree' | 'panel'
  | 'diff' | 'form' | 'product_card' | 'status_grid';

export interface WidgetAction {
  id: string;
  label: string;
  style?: string;
}

export interface WidgetSpec {
  id: string;
  kind: WidgetKind;
  title?: string;
  props: Record<string, unknown>;
  actions?: WidgetAction[];
}

export interface WidgetMetadata {
  spec: WidgetSpec;
}

/** Diff-viewer payload for `write_file`. Owned by the producer
 *  (`capabilities/tools/core.ts`); the TUI parses it via `isFileWriteMetadata`.
 *  `oldContent`/`newContent` are omitted when `diffSkipped` (oversized) so we
 *  don't hold large strings. */
export interface FileWriteMetadata {
  path: string;
  isNewFile: boolean;
  byteDelta: number;
  oldContent?: string | null;   // null ⇒ new file; omitted when diffSkipped
  newContent?: string;          // omitted when diffSkipped
  diffSkipped?: boolean;
  skipReason?: string;
  /** Index signature so this typed payload satisfies ToolResult.metadata's
   *  Record<string, unknown> without a cast at the producer site. */
  [key: string]: unknown;
}
