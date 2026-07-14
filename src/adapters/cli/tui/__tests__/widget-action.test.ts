/**
 * Widget action round-trip integration test.
 *
 * Exercises: widgetHost.mount → dispatchAction → synthetic message
 * → format matches contract §6. Does not require Ink/React rendering.
 */
import { describe, it, expect } from 'vitest';
import { createWidgetHost } from '../widget-host.js';
import { generateId } from '../../../../core/message-convert.js';
import type { FeedApi, FeedEntry, FeedEntryInput, BlockEntry } from '../types.js';

/** Non-React feed for testing — same FeedApi interface. */
function createTestFeed(): FeedApi {
  let entries: FeedEntry[] = [];
  return {
    get entries() { return entries; },
    appendEntry(input: FeedEntryInput): string {
      const id = generateId();
      entries = [...entries, { ...input, id } as FeedEntry];
      return id;
    },
    updateEntry(id: string, patch: Partial<FeedEntry>): void {
      entries = entries.map((e) => (e.id === id ? ({ ...e, ...patch } as FeedEntry) : e));
    },
    clear(): void {
      entries = [];
    },
    updateBlockEntry(id: string, patch: Partial<BlockEntry>): void {
      entries = entries.map((e) => (e.id === id ? ({ ...e, ...patch } as FeedEntry) : e));
    },
  };
}

describe('widget action round-trip', () => {
  it('dispatchAction produces correct synthetic message', () => {
    const feed = createTestFeed();
    const host = createWidgetHost(feed);

    const spec = {
      id: 'w1',
      kind: 'product_card' as const,
      props: { title: 'Test Widget', price: '$9.99' },
      actions: [{ id: 'buy', label: 'Buy', style: 'primary' as const }],
    };

    const instance = host.mount(spec);
    expect(instance.isActive).toBe(true);

    expect(feed.entries).toHaveLength(1);
    expect(feed.entries[0].kind).toBe('block');
    if (feed.entries[0].kind === 'block') {
      expect(feed.entries[0].finalized).toBe(false);
    }

    let capturedSynthetic = '';
    host.setSubmit((s: string) => { capturedSynthetic = s; });

    const synthetic = host.dispatchAction('w1', 'buy');
    expect(synthetic).toBe(`[widget:w1] action "buy"`);
    expect(capturedSynthetic).toBe(synthetic);

    // One-shot finalizes after dispatch
    expect(instance.isActive).toBe(false);
  });

  it('dispatchAction with state produces state-annotated synthetic', () => {
    const feed = createTestFeed();
    const host = createWidgetHost(feed);
    host.mount({
      id: 'form1',
      kind: 'form' as const,
      props: { fields: [{ id: 'name', label: 'Name', type: 'text' }] },
      actions: [{ id: 'submit', label: 'Submit', style: 'primary' as const }],
    });

    let capturedSynthetic = '';
    host.setSubmit((s) => { capturedSynthetic = s; });

    const state = { name: 'Alice' };
    const synthetic = host.dispatchAction('form1', 'submit', state);
    expect(synthetic).toBe(`[widget:form1] action "submit" state {"name":"Alice"}`);
    expect(capturedSynthetic).toBe(synthetic);
  });

  it('drops action when submit not wired (N2 guard)', () => {
    const feed = createTestFeed();
    const host = createWidgetHost(feed);
    const instance = host.mount({
      id: 'w1',
      kind: 'product_card' as const,
      props: { title: 'Widget' },
      actions: [{ id: 'click', label: 'Click', style: 'primary' as const }],
    });

    const synthetic = host.dispatchAction('w1', 'click');
    expect(synthetic).toBe(`[widget:w1] action "click"`);
    // Block must NOT finalize when submit isn't wired — it stays active so
    // when the submit callback arrives later, the widget is still usable.
    expect(instance.isActive).toBe(true);
    // Feed entry must also remain unfinalized.
    const entry = feed.entries[0];
    expect(entry.kind).toBe('block');
    if (entry.kind === 'block') expect(entry.finalized).toBe(false);
  });

  it('finalizeAll freezes all blocks', () => {
    const feed = createTestFeed();
    const host = createWidgetHost(feed);
    host.mount({ id: 'w1', kind: 'table' as const, props: { columns: [], rows: [] } });
    host.mount({ id: 'w2', kind: 'panel' as const, props: { body: 'hello' } });

    host.finalizeAll();
    expect(feed.entries.every((e) => e.kind === 'block' && e.finalized)).toBe(true);
  });

  it('disposeAll clears blocks', () => {
    const feed = createTestFeed();
    const host = createWidgetHost(feed);
    host.mount({ id: 'w1', kind: 'table' as const, props: { columns: [], rows: [] } });

    host.disposeAll();
    expect(host.getSpec('w1')).toBeUndefined();
  });
});
