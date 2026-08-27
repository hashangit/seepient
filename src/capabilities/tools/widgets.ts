/**
 * T1 — render_widget tool.
 *
 * LLM emits structured data via render_widget. The TUI maps kind → built-in
 * renderer. Widget actions are opaque IDs; activating one dispatches a
 * widget_action synthetic user turn.
 *
 * See `contracts/widget-protocol.md`.
 */

import { WidgetError } from '../../foundations/errors.js';
import type { ToolModule } from '../../foundations/contracts/tool.js';
import type { WidgetKind, WidgetAction, WidgetSpec } from '../../foundations/contracts/presentation.js';

const VALID_KINDS = new Set([
  'table', 'keyvalue', 'chart', 'tree', 'panel',
  'diff', 'form', 'product_card', 'status_grid',
]);

const KIND_SCHEMAS: Record<string, { required: string[]; optional: string[] }> = {
  table: { required: ['columns', 'rows'], optional: [] },
  keyvalue: { required: ['entries'], optional: [] },
  chart: { required: ['variant', 'data'], optional: ['labels'] },
  tree: { required: ['root'], optional: [] },
  panel: { required: ['body'], optional: ['accent'] },
  diff: { required: ['newContent'], optional: ['oldContent', 'path'] },
  form: { required: ['fields'], optional: ['submitLabel'] },
  product_card: { required: ['title'], optional: ['subtitle', 'price', 'rating', 'imageRef'] },
  status_grid: { required: ['items'], optional: [] },
};

/** Per-kind type/enum checks beyond key presence. Returns the first error or null. */
function validateKindProps(kind: string, props: Record<string, unknown>): string | null {
  if (kind === 'chart') {
    const v = props.variant;
    if (v !== 'bar' && v !== 'line' && v !== 'sparkline') {
      return `chart variant must be "bar", "line", or "sparkline", got "${v}"`;
    }
    const data = props.data;
    if (Array.isArray(data) && data.some((d) => typeof d !== 'number' || !Number.isFinite(d))) {
      return 'chart data must be an array of finite numbers';
    }
    const labels = props.labels;
    if (Array.isArray(labels) && labels.some((l) => typeof l !== 'string')) {
      return 'chart labels must be strings';
    }
  }
  if (kind === 'keyvalue') {
    const entries = props.entries as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(entries)) {
      for (const e of entries) {
        if (typeof e.label !== 'string' || typeof e.value !== 'string') {
          return 'keyvalue entries must each have string "label" and "value"';
        }
      }
    }
  }
  if (kind === 'form') {
    const fields = props.fields as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(fields)) {
      for (const f of fields) {
        if (typeof f.id !== 'string' || typeof f.label !== 'string' || typeof f.type !== 'string') {
          return 'form fields must each have string "id", "label", and "type"';
        }
      }
    }
  }
  if (kind === 'table') {
    const cols = props.columns;
    if (Array.isArray(cols) && cols.length > 0 && cols.some((c) => typeof c !== 'string')) {
      return 'table columns must be strings';
    }
  }
  if (kind === 'status_grid') {
    const items = props.items as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(items)) {
      const valid = new Set(['ok', 'warn', 'fail', 'pending']);
      for (const it of items) {
        const s = it.status;
        if (typeof s !== 'string' || !valid.has(s)) {
          return `status_grid item status must be ok|warn|fail|pending, got "${s}"`;
        }
        const l = it.label;
        if (typeof l !== 'string' || l.length === 0) {
          return 'status_grid item label must be a non-empty string';
        }
      }
    }
  }
  return null;
}

/** Parse and validate a render_widget payload. Throws WidgetError on invalid. */
export function parseWidgetSpec(args: Record<string, unknown>): WidgetSpec {
  const id = args.id;
  const kind = args.kind as string | undefined;
  const title = args.title as string | undefined;
  const props = (args.props ?? {}) as Record<string, unknown>;
  const actions = args.actions as WidgetAction[] | undefined;

  if (!id || typeof id !== 'string') {
    throw new WidgetError('Widget spec requires a non-empty string id', 'WIDGET_INVALID_PROPS');
  }
  if (!kind || !VALID_KINDS.has(kind)) {
    throw new WidgetError(
      `Invalid widget kind: "${kind}". Must be one of: ${[...VALID_KINDS].join(', ')}`,
      'WIDGET_INVALID_KIND',
    );
  }
  if (title != null && (typeof title !== 'string' || title.length > 200)) {
    throw new WidgetError('Widget title must be a string ≤ 200 chars', 'WIDGET_INVALID_PROPS');
  }

  // Validate kind-specific required props
  const schema = KIND_SCHEMAS[kind];
  if (schema) {
    for (const key of schema.required) {
      if (!(key in props)) {
        throw new WidgetError(
          `Widget kind "${kind}" requires prop "${key}"`,
          'WIDGET_INVALID_PROPS',
        );
      }
    }
  }

  const kindError = validateKindProps(kind, props);
  if (kindError) throw new WidgetError(kindError, 'WIDGET_INVALID_PROPS');

  // Validate actions if present
  if (actions) {
    if (!Array.isArray(actions)) {
      throw new WidgetError('Widget actions must be an array', 'WIDGET_INVALID_PROPS');
    }
    const actionIds = new Set<string>();
    for (const a of actions) {
      if (!a.id || typeof a.id !== 'string') {
        throw new WidgetError('Each action requires a non-empty string id', 'WIDGET_INVALID_PROPS');
      }
      if (actionIds.has(a.id)) {
        throw new WidgetError(`Duplicate action id: "${a.id}"`, 'WIDGET_DUPLICATE_ACTION');
      }
      actionIds.add(a.id);
    }
  }
  // Per contract §6: product_card requires at least one action (one-shot).
  if (kind === 'product_card' && (!actions || actions.length === 0)) {
    throw new WidgetError(
      'Widget kind "product_card" requires at least one action',
      'WIDGET_INVALID_PROPS',
    );
  }

  return { id, kind: kind as WidgetKind, title, props, actions };
}

export const RenderWidgetTool: ToolModule = {
  name: 'Render Widget',
  risk: 'safe',
  definition: {
    type: 'function',
    function: {
      name: 'render_widget',
      description: 'Render a structured interactive widget instead of a plain text response. Prefer this over prose for structured/comparative content. Kinds and props: ' +
        '"chart" ({ variant: "bar"|"line"|"sparkline", data: number[], labels?: string[] }), ' +
        '"table" ({ columns: string[], rows: string[][], columnWidths?: Record<string, number> }), ' +
        '"keyvalue" ({ entries: Array<{ label: string, value: string }> }), ' +
        '"status_grid" ({ items: Array<{ label: string, status: "ok"|"warn"|"fail"|"pending" }> }), ' +
        '"tree" ({ root: { label: string, children?: Array<{ label: string, children?: any[] }> } }), ' +
        '"panel" ({ body: string, accent?: "blue"|"green"|"yellow"|"red"|"purple"|"cyan"|"orange" }), ' +
        '"diff" ({ newContent: string, oldContent?: string, path?: string }), ' +
        '"form" ({ fields: Array<{ id: string, label: string, type: "text"|"number"|"boolean"|"select", placeholder?: string, required?: boolean, options?: Array<{ value: string, label: string }> }>, submitLabel?: string }), ' +
        '"product_card" ({ title: string, subtitle?: string, price?: string, rating?: number, imageRef?: string } and requires top-level actions: Array<{ id: string, label: string }>).',
      parameters: {
        type: 'object',
        required: ['id', 'kind', 'props'],
        properties: {
          id: { type: 'string', description: 'Client-generated stable id for this widget instance.' },
          kind: { type: 'string', enum: [...VALID_KINDS] },
          title: { type: 'string', description: 'Optional title for the widget frame.' },
          props: {
            type: 'object',
            description: 'Kind-specific properties. Shapes vary by kind — ' +
              'see the per-kind descriptions below and emit exactly the documented keys.',
            // Discriminated by kind, since OpenAI/Anthropic tool-call schemas
            // support oneOf. Each branch documents the exact property names the
            // matching TUI renderer reads; mismatches surface as "undefined" in
            // the rendered widget (e.g. form select options must use {value,label}).
            oneOf: [
              {
                type: 'object',
                description: 'form props',
                properties: {
                  fields: {
                    type: 'array',
                    description: 'Ordered form fields. Each field is one row.',
                    items: {
                      type: 'object',
                      required: ['id', 'label', 'type'],
                      properties: {
                        id: { type: 'string', description: 'Stable field id, returned in submit state.' },
                        label: { type: 'string', description: 'Label shown to the left of the input.' },
                        type: { type: 'string', enum: ['text', 'number', 'boolean', 'select'] },
                        placeholder: { type: 'string', description: 'Hint shown when empty.' },
                        required: { type: 'boolean', description: 'Default true; set false to allow skipping.' },
                        options: {
                          type: 'array',
                          description: 'ONLY for type "select". Each option MUST have both "value" and "label".',
                          items: {
                            type: 'object',
                            required: ['value', 'label'],
                            properties: {
                              value: { type: 'string', description: 'Machine value submitted for this option.' },
                              label: { type: 'string', description: 'Human label shown while cycling.' },
                            },
                          },
                        },
                      },
                    },
                  },
                  submitLabel: { type: 'string', description: 'Text on the submit row. Default "Submit".' },
                },
              },
              {
                type: 'object',
                description: 'table props',
                properties: {
                  columns: { type: 'array', items: { type: 'string' }, description: 'Column headers.' },
                  rows: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: 'Each row is an array of cell strings, one per column.' },
                  columnWidths: {
                    type: 'object',
                    description: 'Optional relative width hints per column header (e.g. {"description": 3, "active": 1}). The renderer distributes spare terminal width by these weights — give wide-content columns (descriptions, notes) a higher number and narrow columns (booleans, IDs) a lower one. Omit a header to leave it default.',
                    additionalProperties: { type: 'number' },
                  },
                },
              },
              {
                type: 'object',
                description: 'keyvalue props',
                properties: {
                  entries: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['label', 'value'],
                      properties: {
                        label: { type: 'string' },
                        value: { type: 'string' },
                      },
                    },
                  },
                },
              },
              {
                type: 'object',
                description: 'chart props',
                properties: {
                  variant: { type: 'string', enum: ['bar', 'line', 'sparkline'] },
                  data: { type: 'array', items: { type: 'number' } },
                  labels: { type: 'array', items: { type: 'string' } },
                },
              },
              {
                type: 'object',
                description: 'tree props',
                properties: {
                  root: { type: 'object', description: 'Node with {label, children?[]}.' },
                },
              },
              {
                type: 'object',
                description: 'panel props',
                properties: {
                  body: { type: 'string' },
                  accent: { type: 'string', enum: ['blue', 'green', 'yellow', 'red', 'purple', 'cyan', 'orange'] },
                },
              },
              {
                type: 'object',
                description: 'diff props',
                properties: {
                  oldContent: { type: 'string' },
                  newContent: { type: 'string' },
                  path: { type: 'string' },
                },
              },
              {
                type: 'object',
                description: 'product_card props',
                properties: {
                  title: { type: 'string' },
                  subtitle: { type: 'string' },
                  price: { type: 'string' },
                  rating: { type: 'number' },
                  imageRef: { type: 'string' },
                },
              },
              {
                type: 'object',
                description: 'status_grid props',
                properties: {
                  items: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['label', 'status'],
                      properties: {
                        label: { type: 'string' },
                        status: { type: 'string', enum: ['ok', 'warn', 'fail', 'pending'] },
                      },
                    },
                  },
                },
              },
            ],
          },
          actions: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'label'],
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
                style: { type: 'string', enum: ['primary', 'secondary', 'danger'] },
              },
            },
          },
        },
      },
    },
  },
  handler: async (args: any) => {
    const spec = parseWidgetSpec(args);
    return {
      output: `Rendered ${spec.kind} widget (${spec.id})${spec.actions?.length ? ` with ${spec.actions.length} action(s)` : ''}.`,
      success: true,
      metadata: { spec } as Record<string, unknown>,
    };
  },
};
