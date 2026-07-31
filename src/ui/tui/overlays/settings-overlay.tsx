import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useTheme } from '../hooks/use-theme.js';

export interface SettingItem {
  dotKey: string;
  value: string;
  category: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'enum';
  secret: boolean;
  enumValues?: string[];
  restartRequired: boolean;
}

interface SettingsEditorProps {
  settings: SettingItem[];
  onSet: (dotKey: string, value: string) => Promise<void>;
  onClose: () => void;
}

type Mode = 'browse' | 'select' | 'input';
const MAX_VISIBLE = 12;

/** Options for a setting (boolean → ['true','false']; enum → enumValues). */
function optionsFor(s: SettingItem): string[] {
  if (s.type === 'boolean') return ['true', 'false'];
  return s.enumValues ?? [];
}

/**
 * Type-aware settings editor.
 * - browse: ↑/↓ navigate categorized list; Enter edits.
 * - select (boolean/enum): ←/→ cycle through options; Enter saves.
 * - input (string/number/secret): type a value; Enter saves.
 * After saving, the caller refreshes the list so the new value is visible.
 */
export function SettingsEditor({ settings, onSet, onClose }: SettingsEditorProps) {
  const theme = useTheme();
  const [mode, setMode] = useState<Mode>('browse');
  const [selected, setSelected] = useState(0);
  const [inputVal, setInputVal] = useState('');
  const [optIdx, setOptIdx] = useState(0);
  const [feedback, setFeedback] = useState('');

  const cur = settings[selected];

  const enterEdit = (): void => {
    if (!cur) return;
    setFeedback('');
    if (cur.type === 'boolean' || cur.type === 'enum') {
      const opts = optionsFor(cur);
      const idx = opts.indexOf(cur.value);
      setOptIdx(idx >= 0 ? idx : 0);
      setMode('select');
    } else {
      setInputVal(cur.value === '(not set)' || cur.value === '******' ? '' : cur.value);
      setMode('input');
    }
  };

  const save = (value: string): void => {
    if (!cur) return;
    void onSet(cur.dotKey, value)
      .then(() => { setFeedback(`✓ ${cur.label} saved${cur.restartRequired ? ' (restart required)' : ''}`); })
      .catch(() => { setFeedback(`✗ Failed to save ${cur.label}`); });
    setMode('browse');
  };

  useInput((input, key) => {
    if (mode === 'browse') {
      if (key.escape) { onClose(); return; }
      if (key.return) { enterEdit(); return; }
      if (key.upArrow) { setSelected((i) => Math.max(0, i - 1)); setFeedback(''); }
      if (key.downArrow) { setSelected((i) => Math.min(settings.length - 1, i + 1)); setFeedback(''); }
      return;
    }
    if (mode === 'select') {
      if (key.escape) { setMode('browse'); return; }
      if (key.return) { save(optionsFor(cur)[optIdx]); return; }
      if (key.leftArrow || key.upArrow) setOptIdx((i) => Math.max(0, i - 1));
      if (key.rightArrow || key.downArrow) setOptIdx((i) => Math.min(optionsFor(cur).length - 1, i + 1));
      return;
    }
    // input mode
    if (key.escape) { setMode('browse'); return; }
    if (key.return) { save(inputVal); return; }
    if (key.backspace || key.delete) { setInputVal((v) => v.slice(0, -1)); return; }
    if (input && !key.ctrl && !key.meta && input.length >= 1 && input >= ' ' && !/\x1b?\[\d[\d;]*[~A-Za-z]/.test(input)) {
      setInputVal((v) => v + input);
    }
  });

  // ── Select mode (boolean / enum) ──────────────────────────────────────
  if (mode === 'select' && cur) {
    const opts = optionsFor(cur);
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.cyan} paddingLeft={1} paddingRight={1}>
        <Text color={theme.cyan} bold>{cur.label}</Text>
        <Text color={theme.fgDim}>{cur.dotKey}</Text>
        <Box marginTop={1}>
          {opts.map((o, i) => (
            <Box key={o}>
              <Text backgroundColor={i === optIdx ? theme.blue : undefined} color={i === optIdx ? theme.bg : i === opts.indexOf(cur.value) ? theme.green : theme.fgDim}>
                {i === optIdx ? ` ◉ ${o} ` : ` ○ ${o} `}
              </Text>
            </Box>
          ))}
        </Box>
        <Text color={theme.fgDim}>←/→ change · Enter save · Esc cancel{cur.restartRequired ? ' · ⚠ restart required' : ''}</Text>
      </Box>
    );
  }

  // ── Input mode (string / number / secret) ─────────────────────────────
  if (mode === 'input' && cur) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.cyan} paddingLeft={1} paddingRight={1}>
        <Text color={theme.cyan} bold>{cur.label}</Text>
        <Text color={theme.fgDim}>{cur.dotKey}</Text>
        <Text color={theme.fgDim}>Current: {cur.value}</Text>
        <Box>
          <Text color={theme.green} bold>› </Text>
          <Text color={cur.secret ? theme.yellow : theme.fg}>{cur.secret ? '•'.repeat(inputVal.length) : inputVal}</Text>
          <Text color={theme.fgDim}> _</Text>
        </Box>
        <Text color={theme.fgDim}>Enter save · Esc cancel{cur.restartRequired ? ' · ⚠ restart required' : ''}</Text>
      </Box>
    );
  }

  // ── Browse mode ───────────────────────────────────────────────────────
  const half = Math.floor(MAX_VISIBLE / 2);
  const start = Math.max(0, Math.min(selected - half, settings.length - MAX_VISIBLE));
  const visible = settings.slice(start, start + MAX_VISIBLE);
  let lastCat: string | null = start > 0 ? settings[start - 1]?.category : null;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.purple} paddingLeft={1} paddingRight={1}>
      <Text color={theme.purple} bold>Settings</Text>
      <Text color={theme.fgDim}>↑/↓ navigate · Enter edit · Esc close</Text>
      {feedback ? <Text color={feedback.startsWith('✓') ? theme.green : theme.red}>{feedback}</Text> : null}
      {visible.map((s) => {
        const idx = settings.indexOf(s);
        const sel = idx === selected;
        const showCat = s.category !== lastCat;
        lastCat = s.category;
        const valDisplay = s.type === 'boolean'
          ? (s.value === 'true' ? '✓ on' : '✗ off')
          : s.value;
        return (
          <Box key={s.dotKey} flexDirection="column">
            {showCat ? <Text color={theme.cyan} bold>  {s.category}</Text> : null}
            <Box>
              <Text backgroundColor={sel ? theme.blue : undefined} color={sel ? theme.bg : theme.fg}>
                {sel ? '▶ ' : '  '}{s.label}
              </Text>
              <Text backgroundColor={sel ? theme.blue : undefined} color={sel ? theme.bg : theme.fgDim}>
                {sel ? ` = ${valDisplay}` : `  ${valDisplay}`}
              </Text>
              {s.restartRequired ? <Text color={theme.yellow}> ⚠</Text> : null}
            </Box>
          </Box>
        );
      })}
      {settings.length > MAX_VISIBLE ? (
        <Text color={theme.fgDim}>  {start + 1}–{Math.min(start + MAX_VISIBLE, settings.length)} of {settings.length}</Text>
      ) : null}
    </Box>
  );
}
