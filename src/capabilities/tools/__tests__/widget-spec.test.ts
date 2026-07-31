/**
 * Widget spec parser unit tests.
 */
import { describe, it, expect } from 'vitest';
import { parseWidgetSpec } from '../widgets.js';

describe('parseWidgetSpec', () => {
  it('parses a valid mini table spec', () => {
    const spec = parseWidgetSpec({
      id: 't1',
      kind: 'table',
      props: { columns: ['Name'], rows: [['Alice']] },
    });
    expect(spec.id).toBe('t1');
    expect(spec.kind).toBe('table');
    expect(spec.props.columns).toHaveLength(1);
  });

  it('parses a spec with actions', () => {
    const spec = parseWidgetSpec({
      id: 'p1',
      kind: 'product_card',
      props: { title: 'Widget' },
      actions: [{ id: 'buy', label: 'Buy', style: 'primary' }],
    });
    expect(spec.actions).toHaveLength(1);
  });

  it('parses with optional title', () => {
    const spec = parseWidgetSpec({ id: 'p1', kind: 'panel', props: { body: 'hello' }, title: 'My Panel' });
    expect(spec.title).toBe('My Panel');
  });

  it('throws on missing id', () => {
    expect(() => parseWidgetSpec({ kind: 'table', props: { columns: [], rows: [] } } as any))
      .toThrow(/requires|non-empty/);
  });

  it('throws on empty id', () => {
    expect(() => parseWidgetSpec({ id: '', kind: 'table', props: {} }))
      .toThrow(/requires|non-empty/);
  });

  it('throws on unknown kind', () => {
    expect(() => parseWidgetSpec({ id: 'x', kind: 'mystery', props: {} }))
      .toThrow(/Invalid widget kind/);
  });

  it('throws on title over 200 chars', () => {
    expect(() => parseWidgetSpec({ id: 'x', kind: 'panel', props: { body: 'hi' }, title: 'x'.repeat(201) }))
      .toThrow(/≤ 200|string/);
  });

  it('throws on missing required prop for table', () => {
    expect(() => parseWidgetSpec({ id: 't1', kind: 'table', props: {} }))
      .toThrow(/requires prop/);
  });

  it('throws on duplicate action ids', () => {
    expect(() => parseWidgetSpec({
      id: 'p1',
      kind: 'product_card',
      props: { title: 'Widget' },
      actions: [{ id: 'dup', label: 'A' }, { id: 'dup', label: 'B' }],
    })).toThrow(/Duplicate action/);
  });

  it('throws on non-array actions', () => {
    expect(() => parseWidgetSpec({ id: 'x', kind: 'panel', props: { body: 'hi' }, actions: 'nope' } as any))
      .toThrow(/must be an array/);
  });

  it('accepts optional props for all 9 kinds', () => {
    const kinds = ['table', 'keyvalue', 'chart', 'tree', 'panel', 'diff', 'form', 'product_card', 'status_grid'];
    for (const kind of kinds) {
      const props: Record<string, unknown> = {};
      // Minimal required props per kind
      if (kind === 'table') Object.assign(props, { columns: [], rows: [] });
      if (kind === 'keyvalue') Object.assign(props, { entries: [] });
      if (kind === 'chart') Object.assign(props, { variant: 'bar', data: [] });
      if (kind === 'tree') Object.assign(props, { root: { label: 'root' } });
      if (kind === 'panel') Object.assign(props, { body: 'text' });
      if (kind === 'diff') Object.assign(props, { newContent: 'new' });
      if (kind === 'form') Object.assign(props, { fields: [] });
      if (kind === 'product_card') Object.assign(props, { title: 'Widget' });
      if (kind === 'status_grid') Object.assign(props, { items: [] });
      const spec = kind === 'product_card'
        ? { id: 'test', kind, props, actions: [{ id: 'buy', label: 'Buy' }] }
        : { id: 'test', kind, props };
      expect(() => parseWidgetSpec(spec)).not.toThrow();
    }
  });

  it('rejects chart with invalid variant', () => {
    expect(() => parseWidgetSpec({
      id: 'c1', kind: 'chart',
      props: { variant: 'pie', data: [1, 2] },
    })).toThrow(/chart variant/);
  });

  it('rejects status_grid with bad status value', () => {
    expect(() => parseWidgetSpec({
      id: 'sg1', kind: 'status_grid',
      props: { items: [{ label: 'x', status: 'broken' }] },
    })).toThrow(/status_grid/);
  });

  it('rejects status_grid item with missing label', () => {
    expect(() => parseWidgetSpec({
      id: 'sg1', kind: 'status_grid',
      props: { items: [{ status: 'ok' }] },
    })).toThrow(/label/);
  });

  it('rejects status_grid item with non-string label', () => {
    expect(() => parseWidgetSpec({
      id: 'sg1', kind: 'status_grid',
      props: { items: [{ label: 42, status: 'ok' }] },
    })).toThrow(/label/);
  });

  it('rejects table with object columns', () => {
    expect(() => parseWidgetSpec({
      id: 't1', kind: 'table',
      props: { columns: [{ key: 'name', label: 'Name' }], rows: [] },
    })).toThrow(/columns must be strings/);
  });

  it('rejects chart with non-numeric data', () => {
    expect(() => parseWidgetSpec({
      id: 'c1', kind: 'chart',
      props: { variant: 'bar', data: [1, 'oops', 3] },
    })).toThrow(/data must be an array of finite numbers/);
  });

  it('rejects chart with non-string labels', () => {
    expect(() => parseWidgetSpec({
      id: 'c1', kind: 'chart',
      props: { variant: 'bar', data: [1, 2], labels: ['a', 5] },
    })).toThrow(/labels must be strings/);
  });

  it('rejects keyvalue entry missing label or value', () => {
    expect(() => parseWidgetSpec({
      id: 'kv1', kind: 'keyvalue',
      props: { entries: [{ label: 'x' }] },
    })).toThrow(/label.*value|entries/);
    expect(() => parseWidgetSpec({
      id: 'kv2', kind: 'keyvalue',
      props: { entries: [{ value: 'y' }] },
    })).toThrow(/label.*value|entries/);
  });

  it('rejects form field missing id, label, or type', () => {
    expect(() => parseWidgetSpec({
      id: 'f1', kind: 'form',
      props: { fields: [{ label: 'Name', type: 'text' }] },
    })).toThrow(/fields must each have/);
    expect(() => parseWidgetSpec({
      id: 'f2', kind: 'form',
      props: { fields: [{ id: 'n', label: 'Name' }] },
    })).toThrow(/fields must each have/);
  });
});
