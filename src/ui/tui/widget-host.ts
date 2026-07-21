/**
 * T4-2 — Widget host controller.
 *
 * Bridges the tool layer (render_widget) to the TUI (ChatBlock). Mounts
 * widgets as live blocks, tracks their instances, and dispatches actions
 * back to the agent loop as synthetic user turns.
 *
 * See `contracts/widget-protocol.md`.
 */

import type { ChatBlockInstance } from './chat-block.js';
import type { FeedApi } from './hooks/use-feed.js';
import type { WidgetSpec } from './widgets/types.js';
import { createChatBlock } from './chat-block.js';

export interface WidgetActionDispatch {
  widgetId: string;
  actionId: string;
  state?: Record<string, unknown>;
  timestamp: string;
}

export interface WidgetHost {
  mount(spec: WidgetSpec): ChatBlockInstance;
  dispatchAction(widgetId: string, actionId: string, state?: Record<string, unknown>): string;
  getSpec(widgetId: string): WidgetSpec | undefined;
  finalizeAll(): void;
  disposeAll(): void;
  setSubmit(fn: (synthetic: string) => void): void;
}

/** Create a WidgetHost backed by feed. The submit callback is set later
 *  via setSubmit() since it's created inside useAgent. */
export function createWidgetHost(feed: FeedApi): WidgetHost {
  const blocks = new Map<string, { instance: ChatBlockInstance; spec: WidgetSpec }>();
  let onSubmitRef: ((synthetic: string) => void) | null = null;

  const ONE_SHOT_KINDS = new Set(['form', 'product_card']);

  function isOneShot(spec: WidgetSpec): boolean {
    return ONE_SHOT_KINDS.has(spec.kind);
  }

  const host: WidgetHost = {
    mount(spec: WidgetSpec): ChatBlockInstance {
      const existing = blocks.get(spec.id);
      if (existing && existing.instance.isActive) existing.instance.finalize();
      const instance = createChatBlock(feed, 'widget', spec);
      blocks.set(spec.id, { instance, spec });
      return instance;
    },

    dispatchAction(widgetId: string, actionId: string, state?: Record<string, unknown>): string {
      const dispatch: WidgetActionDispatch = {
        widgetId,
        actionId,
        state,
        timestamp: new Date().toISOString(),
      };
      const synthetic = `[widget:${dispatch.widgetId}] action "${dispatch.actionId}"${dispatch.state ? ` state ${JSON.stringify(dispatch.state)}` : ''}`;
      if (!onSubmitRef) return synthetic; // submit not yet wired — action dropped

      onSubmitRef(synthetic);

      const entry = blocks.get(widgetId);
      if (entry && isOneShot(entry.spec)) {
        entry.instance.finalize();
      }

      return synthetic;
    },

    getSpec(widgetId: string): WidgetSpec | undefined {
      return blocks.get(widgetId)?.spec;
    },

    finalizeAll(): void {
      for (const { instance } of blocks.values()) {
        if (instance.isActive) instance.finalize();
      }
    },

    disposeAll(): void {
      for (const { instance } of blocks.values()) {
        if (instance.isActive) instance.dispose();
      }
      blocks.clear();
    },

    setSubmit(fn: (synthetic: string) => void): void {
      onSubmitRef = fn;
    },
  };

  return host;
}
