import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useTheme } from '../hooks/use-theme.js';
import type { WidgetSpec } from './types.js';

interface FormField {
  id: string;
  label: string;
  type: 'text' | 'number' | 'boolean' | 'select';
  placeholder?: string;
  required?: boolean;
  options?: Array<{ value: string; label: string }>;
}

interface ValidationError {
  fieldId: string;
  message: string;
}

function validateFormValues(fields: FormField[], values: Record<string, unknown>): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const f of fields) {
    const v = values[f.id];
    const required = f.required !== false; // default required unless explicitly false
    // Required check applies to every type (contract §6): empty value on a
    // required field fails before type/format checks.
    if (required && (v === undefined || v === '' || v === null)) {
      errors.push({ fieldId: f.id, message: 'This field is required' });
      continue; // no point checking format on an empty required field
    }
    if (f.type === 'number' && typeof v === 'string' && v.length > 0) {
      const n = Number(v);
      if (isNaN(n) || !isFinite(n)) errors.push({ fieldId: f.id, message: `"${v}" is not a valid number` });
    }
    if (f.type === 'select' && f.options && typeof v === 'string' && v.length > 0) {
      const validValues = f.options.map((o) => o.value);
      if (!validValues.includes(v)) errors.push({ fieldId: f.id, message: `"${v}" is not a valid option` });
    }
  }
  return errors;
}

export const FormWidget = React.memo(function FormWidget({ spec, finalized, interactive, onAction }: {
  spec: WidgetSpec;
  finalized: boolean;
  interactive?: boolean;
  onAction?: (actionId: string, state?: Record<string, unknown>) => void;
}) {
  const theme = useTheme();
  const rawFields = Array.isArray(spec.props.fields) ? (spec.props.fields as FormField[]) : [];
  // Drop fields missing the keys the renderer touches (id, label, type).
  const fields = rawFields.filter(
    (f) => f && typeof f.id === 'string' && typeof f.label === 'string' && typeof f.type === 'string',
  );
  const submitLabel = (spec.props.submitLabel as string) ?? 'Submit';

  const [values, setValues] = useState<Record<string, unknown>>(
    () => Object.fromEntries(fields.map((f) => {
      if (f.type === 'boolean') return [f.id, false];
      if (f.type === 'select' && f.options && f.options.length > 0) return [f.id, f.options[0].value];
      return [f.id, ''];
    })),
  );
  // focusedField ranges from 0 to fields.length. Index fields.length is the
  // virtual submit button — the last navigable row. This avoids depending on
  // modified-Enter keys (Ctrl+Enter etc.) which macOS Terminal doesn't send.
  const [focusedField, setFocusedField] = useState(0);
  const [errors, setErrors] = useState<ValidationError[]>([]);
  const [submitted, setSubmitted] = useState(false);

  // Ink useInput — MUST be called unconditionally (same hook count on every render),
  // but `isActive: false` prevents Ink from registering a stdin listener on
  // non-interactive forms. Without this, every form ever rendered leaks a
  // listener on Ink's shared EventEmitter (MaxListenersExceededWarning).
  const hasFields = fields.length > 0;
  const formActive = !submitted && !finalized && !!interactive && hasFields;
  // Total navigable rows: real fields + 1 virtual submit button.
  const totalRows = fields.length + 1;
  const submitIdx = fields.length;

  const doSubmit = (): void => {
    const validationErrors = validateFormValues(fields, values);
    if (validationErrors.length > 0) {
      setErrors(validationErrors);
      return;
    }
    setErrors([]);
    setSubmitted(true);
    // Dispatch under the declared action id (spec.actions[0].id), not the
    // human label — the agent round-trip needs a stable actionId. Fall back
    // to 'submit' when the model omitted actions (contract §6).
    const actionId = spec.actions?.[0]?.id ?? 'submit';
    if (onAction) onAction(actionId, { ...values });
  };

  useInput((input, key) => {
    if (!formActive) return;

    // ↑/↓ navigate between fields and the submit button (last row).
    if (key.upArrow || key.downArrow) {
      setFocusedField((i) => {
        if (key.upArrow) return (i - 1 + totalRows) % totalRows;
        return (i + 1) % totalRows;
      });
      return;
    }

    // Submit button is focused → Enter submits.
    if (focusedField === submitIdx) {
      if (key.return) doSubmit();
      return;
    }

    const field = fields[focusedField];
    if (!field) return;

    // Boolean: Enter or Space toggles.
    if (field.type === 'boolean') {
      if (key.return || input === ' ') {
        setValues((prev) => ({ ...prev, [field.id]: !prev[field.id] }));
        setErrors([]);
      }
      return;
    }

    // Select: ←/→ cycles through options. Space also cycles forward.
    if (field.type === 'select' && field.options) {
      const opts = field.options;
      if (opts.length === 0) return;
      const cycle = (dir: 1 | -1): void => {
        const curIdx = Math.max(0, opts.findIndex((o) => o.value === (values[field.id] as string)));
        const next = opts[(curIdx + dir + opts.length) % opts.length];
        setValues((prev) => ({ ...prev, [field.id]: next.value }));
        setErrors([]);
      };
      if (key.rightArrow || input === ' ') { cycle(1); return; }
      if (key.leftArrow) { cycle(-1); return; }
      return; // don't fall through to text input
    }

    // Text/number: type into the field.
    // Ctrl+J inserts a newline — reliable across terminals (key.ctrl + 'j'),
    // unlike Shift+Enter / Alt+Enter which macOS Terminal doesn't distinguish
    // from plain Enter.
    if (key.ctrl && input === 'j') {
      setValues((prev) => {
        const cur = (prev[field.id] as string) ?? '';
        return { ...prev, [field.id]: cur + '\n' };
      });
      setErrors([]);
      return;
    }
    if (key.backspace || key.delete) {
      setValues((prev) => {
        const cur = (prev[field.id] as string) ?? '';
        return { ...prev, [field.id]: cur.slice(0, -1) };
      });
    } else if (input) {
      // Filter out control chars that would show as glpyhs
      if (input.length === 1 && input.charCodeAt(0) >= 32) {
        setValues((prev) => {
          const cur = (prev[field.id] as string) ?? '';
          return { ...prev, [field.id]: cur + input };
        });
      }
    }
    setErrors([]);
  }, { isActive: formActive });

  if (fields.length === 0) return <Text color="gray">(no fields)</Text>;

  const errorMap = new Map(errors.map((e) => [e.fieldId, e]));

  if (finalized || submitted) {
    return (
      <Box flexDirection="column">
        {fields.map((f) => (
          <Box key={f.id}>
            <Text color={theme.fgDim}>{f.label}: </Text>
            <Text>{String(values[f.id] ?? '')}</Text>
          </Box>
        ))}
        {submitted ? <Box marginTop={1}><Text color={theme.fgDim}>[submitted]</Text></Box> : null}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {fields.map((f, i) => {
        const focused = i === focusedField;
        const val = values[f.id];
        const err = errorMap.get(f.id);

    let display = '';
    if (f.type === 'boolean') {
      display = val ? '✓ yes' : '✗ no';
    } else if (f.type === 'select' && f.options) {
      const opt = f.options.find((o) => o.value === (val as string));
      // Guard against a malformed option (e.g. missing label) — fall back to
      // the placeholder rather than rendering the literal "undefined".
      display = opt?.label ?? (f.placeholder ?? '(choose)');
    } else {
      display = (val as string) || (f.placeholder ?? `[${f.type}]`);
    }

        const labelColor = focused ? theme.cyan : theme.fgDim;
        return (
          <Box key={f.id} flexDirection="column">
            <Box>
              <Text color={labelColor}>{f.label}: </Text>
              <Text color={focused ? undefined : theme.fgDim}>
                {focused ? `> ${display}_` : display}
              </Text>
            </Box>
            {err ? (
              <Box paddingLeft={2}>
                <Text color={theme.red}>⚠ {err.message}</Text>
              </Box>
            ) : null}
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text color={focusedField === submitIdx
          ? theme.yellow
          : errors.length > 0 ? theme.red : theme.green}
          bold={focusedField === submitIdx}
        >
          {focusedField === submitIdx ? '> ' : ''}{errors.length > 0 ? 'Fix errors above' : submitLabel}{focusedField === submitIdx ? '_' : ''}
        </Text>
        <Text color={theme.fgDim}> (↑/↓ navigate · Enter toggle/select · ←/→ cycle · Ctrl+J newline)</Text>
      </Box>
    </Box>
  );
});
