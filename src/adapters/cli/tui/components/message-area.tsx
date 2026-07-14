import { Box, Static, Text, useStdout } from 'ink';
import { useTheme } from '../hooks/use-theme.js';
import { HORIZONTAL_PADDING } from '../layout.js';
import type { FeedEntry, BlockEntry } from '../types.js';
import { UserMessage } from './user-message.js';
import { AssistantMessage } from './assistant-message.js';
import { ToolCallBlock } from './tool-call-block.js';
import { ErrorMessage } from './error-message.js';
import { InfoMessage } from './info-message.js';
import { LogoBanner } from './logo-banner.js';
import { SkillsList } from './skills-list.js';
import { WidgetBlock } from '../widgets/widget-block.js';
import type { WidgetSpec } from '../widgets/types.js';

function isBlock(e: FeedEntry): e is BlockEntry {
  return e.kind === 'block';
}

function isLiveBlock(e: FeedEntry): boolean {
  return isBlock(e) && !e.finalized;
}

/** Defensive: parse the block's props as a WidgetSpec or return null. */
function parseBlockWidgetSpec(props: unknown): WidgetSpec | null {
  if (!props || typeof props !== 'object') return null;
  const p = props as Record<string, unknown>;
  if (typeof p.id !== 'string' || typeof p.kind !== 'string' || !p.props) return null;
  return p as unknown as WidgetSpec;
}

/**
 * Renders a `blockKind: 'custom'` entry by dispatching on `props.component`.
 * Structured command output (e.g. /skills) flows through here instead of being
 * ANSI-stripped into a flat assistant message.
 */
function CustomBlock({ props }: { props: unknown }) {
  const p = (props ?? {}) as Record<string, unknown>;
  if (p.component === 'skills' && Array.isArray(p.skills)) {
    return <SkillsList skills={p.skills as Array<{ name: string; description: string }>} />;
  }
  return <Text color="gray">[unknown custom block]</Text>;
}

/** Renders one feed entry by kind. */
function FeedItem({ entry, expanded, focusedWidgetId, onWidgetAction }: {
  entry: FeedEntry;
  expanded: boolean;
  focusedWidgetId: string | null;
  onWidgetAction?: (spec: WidgetSpec, actionId: string, state?: Record<string, unknown>) => void;
}) {
  switch (entry.kind) {
    case 'user':
      return <UserMessage entry={entry} />;
    case 'assistant':
      return <AssistantMessage entry={entry} />;
    case 'tool':
      return <ToolCallBlock entry={entry} expanded={expanded} />;
    case 'error':
      return <ErrorMessage entry={entry} />;
    case 'info':
      return <InfoMessage entry={entry} />;
    case 'logo':
      return <LogoBanner />;
    case 'block': {
      // 'widget' blockKind is the primary case; 'custom' renders structured
      // command output (e.g. /skills). thinking/live-tool are deferred (T4-3, T4-4).
      if (entry.blockKind === 'custom') {
        return <CustomBlock props={entry.props} />;
      }
      if (entry.blockKind !== 'widget') return <Text color="gray">[block ({entry.blockKind})]</Text>;
      const spec = parseBlockWidgetSpec(entry.props);
      if (!spec) return <Text color="gray">[invalid block]</Text>;
      return (
        <WidgetBlock
          spec={spec}
          finalized={entry.finalized}
          interactive={focusedWidgetId === entry.id && !entry.finalized}
          onAction={onWidgetAction ? (actionId, state) => onWidgetAction(spec, actionId, state) : undefined}
        />
      );
    }
  }
}

/**
 * Scrollable feed. Completed entries render via Ink's `<Static>` (each item is
 * painted once and scrolls into the terminal's native scrollback); the
 * pending-permission prompt and "working…" indicator are live components in
 * `app.tsx`.
 *
 * Width handling: `<Static>` writes each item at the full terminal width and
 * ignores parent padding, so an item that fills `columns` triggers the
 * terminal's auto-wrap (a phantom row below). Each item is therefore capped at
 * `columns - HORIZONTAL_PADDING` with a matching left pad, giving a symmetric
 * gutter and keeping every line `< columns`. `useStdout` reads the live column
 * count so resize reflows correctly.
 */
export function MessageArea({ entries, staticKey, expanded, focusedWidgetId, onWidgetAction }: {
  entries: FeedEntry[];
  staticKey: number;
  expanded: boolean;
  focusedWidgetId: string | null;
  onWidgetAction?: (spec: WidgetSpec, actionId: string, state?: Record<string, unknown>) => void;
}) {
  const theme = useTheme();
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;
  const itemWidth = Math.max(20, columns - HORIZONTAL_PADDING);

  // T4-1: partition entries into static (frozen) and live blocks.
  // Live blocks render outside <Static> so they can re-render on update.
  const staticEntries = entries.filter((e) => !isLiveBlock(e));
  const liveBlocks = entries.filter(isLiveBlock);

  if (entries.length === 0) {
    return (
      <Box paddingLeft={HORIZONTAL_PADDING}>
        <Text color={theme.fgDim}>No messages yet — type a prompt and press Enter.</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Static key={staticKey} items={staticEntries}>
        {(entry) => (
          <Box key={entry.id} width={itemWidth} paddingLeft={HORIZONTAL_PADDING} marginBottom={1}>
            <FeedItem entry={entry} expanded={expanded} focusedWidgetId={focusedWidgetId} onWidgetAction={onWidgetAction} />
          </Box>
        )}
      </Static>
      {liveBlocks.map((entry) => (
        <Box key={entry.id} width={itemWidth} paddingLeft={HORIZONTAL_PADDING} marginBottom={1}>
          <FeedItem entry={entry} expanded={expanded} focusedWidgetId={focusedWidgetId} onWidgetAction={onWidgetAction} />
        </Box>
      ))}
    </Box>
  );
}
