/**
 * T1 — WidgetBlock skeleton + kind dispatch.
 *
 * Renders a bordered widget frame with optional title and action bar,
 * dispatching on `spec.kind` to a kind-specific renderer.
 *
 * Keyboard: when interactive (agent idle, focused, unfinalized, has
 * actions), ↑/↓ cycles focus across the action bar and Enter fires the
 * focused action. This matches the FormWidget convention so every
 * interactive widget uses the same keys. Plain Enter is safe because a
 * focused widget disables PromptArea's own Enter handler — there is no
 * collision.
 */

import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { useTheme } from '../hooks/use-theme.js';
import type { WidgetSpec } from './types.js';
import { TableWidget } from './table.js';
import { KeyValueWidget } from './keyvalue.js';
import { ChartWidget } from './chart.js';
import { TreeWidget } from './tree.js';
import { PanelWidget } from './panel.js';
import { DiffWidget } from './diff.js';
import { FormWidget } from './form.js';
import { ProductCardWidget } from './product-card.js';
import { StatusGridWidget } from './status-grid.js';

/**
 * Error boundary wrapping each widget renderer. A malformed prop that slips
 * past validation (or a renderer bug) renders a graceful inline message
 * instead of crashing the entire TUI. No widget is worth killing the session.
 */
class WidgetBoundary extends React.Component<
  { children: React.ReactNode; kind: string },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    // Swallow — surfaced inline below. Logging would corrupt the TUI canvas.
    void error;
  }
  render() {
    if (this.state.error) {
      return (
        <Text color="red">⚠ {this.props.kind} widget failed to render: {this.state.error.message}</Text>
      );
    }
    return this.props.children;
  }
}

export interface WidgetBlockProps {
  spec: WidgetSpec;
  finalized: boolean;
  /** When true, the widget captures ↑/↓ and Enter.
   *  Set only when the agent is idle and this widget's actions bar
   *  is the active interactive surface. */
  interactive?: boolean;
  onAction?: (actionId: string, state?: Record<string, unknown>) => void;
}

function TitleBar({ spec }: { spec: WidgetSpec }) {
  const theme = useTheme();
  if (!spec.title) return null;
  return (
    <Box>
      <Text color={theme.purple} bold>{spec.title}</Text>
    </Box>
  );
}

function ActionBar({ spec, finalized, interactive, focusIdx }: {
  spec: WidgetSpec;
  finalized: boolean;
  interactive: boolean;
  focusIdx: number;
}) {
  const theme = useTheme();
  if (!spec.actions || spec.actions.length === 0) return null;

  const frozen = finalized || !interactive;
  const actions = frozen
    ? spec.actions.map((a) => ({ ...a, style: 'secondary' as const }))
    : spec.actions;

  return (
    <Box>
      <Text color={theme.fgDim}>│ </Text>
      {actions.map((a, i) => {
        const focused = i === focusIdx && !frozen;
        const color = a.style === 'primary' ? theme.green
          : a.style === 'danger' ? theme.red
          : theme.fgDim;
        return (
          <React.Fragment key={a.id}>
            {i > 0 ? <Text color={theme.fgDim}> | </Text> : null}
            <Text
              color={focused ? theme.yellow : color}
              bold={focused}
              underline={focused}
            >
              {focused ? `[${a.label}]` : a.label}
            </Text>
          </React.Fragment>
        );
      })}
    </Box>
  );
}

function KindRenderer({ spec, finalized, interactive, onAction }: WidgetBlockProps) {
  switch (spec.kind) {
    case 'table': return <TableWidget spec={spec} />;
    case 'keyvalue': return <KeyValueWidget spec={spec} />;
    case 'chart': return <ChartWidget spec={spec} />;
    case 'tree': return <TreeWidget spec={spec} />;
    case 'panel': return <PanelWidget spec={spec} />;
    case 'diff': return <DiffWidget spec={spec} />;
    case 'form': return <FormWidget spec={spec} finalized={finalized} interactive={!!interactive} onAction={onAction} />;
    case 'product_card': return <ProductCardWidget spec={spec} />;
    case 'status_grid': return <StatusGridWidget spec={spec} />;
    default: return <Text color="gray">Unknown widget kind: {spec.kind}</Text>;
  }
}

export const WidgetBlock = React.memo(function WidgetBlock({ spec, finalized, interactive, onAction }: WidgetBlockProps) {
  const theme = useTheme();
  const [focusIdx, setFocusIdx] = useState(0);
  const actionCount = spec.actions?.length ?? 0;
  const hasActions = actionCount > 0;

  const handleAction = useCallback((actionId: string) => {
    if (finalized) return;
    if (onAction) onAction(actionId);
  }, [finalized, onAction]);

  // ↑/↓ cycles focus across the action bar; Enter fires the focused action.
  // Same key convention as FormWidget — every interactive widget uses one
  // scheme. Plain Enter is safe here because a focused widget disables
  // PromptArea's Enter handler (app.tsx gates it on focusedWidgetId), so the
  // two never compete for the same key.
  //
  // Forms manage their own keyboard input entirely (field nav, cycling,
  // submit), so WidgetBlock must not register a competing handler — Ink
  // dispatches every keystroke to all active useInput listeners, and
  // WidgetBlock would steal ↑/↓ and Enter from the form.
  //
  // `isActive: false` prevents Ink from registering a stdin listener at all on
  // non-interactive widgets — without this, every widget ever rendered leaks a
  // listener on Ink's shared EventEmitter (MaxListenersExceededWarning).
  const isForm = spec.kind === 'form';
  const widgetActive = interactive && hasActions && !finalized && !isForm;
  useInput((_input, key) => {
    if (!widgetActive) return;
    if (key.upArrow || key.downArrow) {
      setFocusIdx((i) => key.upArrow
        ? (i - 1 + actionCount) % actionCount
        : (i + 1) % actionCount);
    } else if (key.return) {
      const action = spec.actions?.[focusIdx];
      if (action) handleAction(action.id);
    }
  }, { isActive: widgetActive });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={widgetActive ? theme.yellow : theme.purple} paddingLeft={1} paddingRight={1}>
      <TitleBar spec={spec} />
      <WidgetBoundary kind={spec.kind}>
        <KindRenderer spec={spec} finalized={finalized} interactive={!!interactive} onAction={onAction} />
      </WidgetBoundary>
      <ActionBar spec={spec} finalized={finalized} interactive={!!interactive} focusIdx={focusIdx} />
    </Box>
  );
});
