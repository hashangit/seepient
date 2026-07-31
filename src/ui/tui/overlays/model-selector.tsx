import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useTheme } from '../hooks/use-theme.js';

export interface ModelOption {
  providerType: string;
  modelId: string;
  modelName: string;
}

interface ModelSelectorProps {
  options: ModelOption[];
  currentModel: string;
  onSwitch: (providerType: string, modelId: string) => void;
  onClose: () => void;
}

const MAX_VISIBLE = 10;

/** Ctrl+M provider/model picker. ↑/↓ navigate, Enter switches, Esc closes. */
export function ModelSelector({ options, currentModel, onSwitch, onClose }: ModelSelectorProps) {
  const theme = useTheme();
  const [selected, setSelected] = useState(() => {
    const idx = options.findIndex((o) => o.modelId === currentModel);
    return idx >= 0 ? idx : 0;
  });

  useInput((_input, key) => {
    if (key.escape) { onClose(); return; }
    if (key.return) {
      const o = options[Math.min(selected, options.length - 1)];
      if (o) onSwitch(o.providerType, o.modelId);
      return;
    }
    if (key.upArrow) setSelected((i) => Math.max(0, i - 1));
    else if (key.downArrow) setSelected((i) => Math.min(options.length - 1, i + 1));
  });

  if (options.length === 0) {
    return (
      <Box borderStyle="round" borderColor={theme.purple} paddingLeft={1} paddingRight={1}>
        <Text color={theme.fgDim}>No configured providers with models. Set API keys via /setup.</Text>
      </Box>
    );
  }

  const half = Math.floor(MAX_VISIBLE / 2);
  const start = Math.max(0, Math.min(selected - half, options.length - MAX_VISIBLE));
  const visible = options.slice(start, start + MAX_VISIBLE);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.purple} paddingLeft={1} paddingRight={1}>
      <Text color={theme.purple} bold>Model Selector</Text>
      <Text color={theme.fgDim}>↑/↓ navigate · Enter switches model + provider · Esc close</Text>
      {visible.map((o, i) => {
        const absIdx = start + i;
        const sel = absIdx === selected;
        const isCurrent = o.modelId === currentModel;
        const prevPt = i > 0 ? visible[i - 1].providerType : (start > 0 ? options[start - 1].providerType : null);
        const showHeader = o.providerType !== prevPt;
        return (
          <Box key={`${o.providerType}/${o.modelId}`} flexDirection="column">
            {showHeader ? <Text color={theme.purple} bold>  {o.providerType}</Text> : null}
            <Text backgroundColor={sel ? theme.blue : undefined} color={sel ? theme.bg : isCurrent ? theme.green : theme.fg}>
              {sel ? '▶ ' : '  '}{isCurrent ? '✓ ' : '  '}{o.modelName}
            </Text>
          </Box>
        );
      })}
      {options.length > MAX_VISIBLE ? (
        <Text color={theme.fgDim}>  {options.length - MAX_VISIBLE} more</Text>
      ) : null}
    </Box>
  );
}
