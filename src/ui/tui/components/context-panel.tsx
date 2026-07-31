import { Box, Text } from 'ink';
import { useTheme } from '../hooks/use-theme.js';
import type { ContextBreakdown } from '../../../foundations/contracts/context.js';

export interface ContextPanelProps {
  breakdown: ContextBreakdown;
  /** Last request's real prompt-token count from the API, if available. */
  contextTokens?: number;
}

/** "12k/200k (6%)" when the limit is known, else just the used amount. */
function fmtContext(used: number, limit?: number): string {
  if (!limit) return `${Math.round(used / 1000)}k`;
  const pct = Math.round((used / limit) * 100);
  return `${Math.round(used / 1000)}k/${Math.round(limit / 1000)}k (${pct}%)`;
}

/**
 * Bordered context-window breakdown rendered for the `/context` command.
 * Mirrors the SkillsList idiom (rounded border, bold title, dim detail) and
 * adds a per-part progress bar scaled relative to the largest part.
 *
 * Token counts are corrected per provider family (OpenAI = exact BPE,
 * Anthropic/GLM = BPE × correction factor). The "Last request" row shows the
 * real per-request prompt tokens from the API when available.
 */
export function ContextPanel({ breakdown, contextTokens }: ContextPanelProps) {
  const theme = useTheme();
  const { parts, total, contextWindow, model } = breakdown;

  const maxTokens = Math.max(...parts.map((p) => p.tokens), 1);
  const barLen = 20;
  const labelWidth = Math.max(...parts.map((p) => p.label.length), 14);

  // Prefer the real API count (accurate tokenization from the provider) when
  // available; fall back to the estimated total (before the first chat, or if
  // the provider doesn't return usage).
  const apiTokens = contextTokens && contextTokens > 0 ? contextTokens : undefined;
  const filledTokens = apiTokens ?? total;

  // Window-fill bar: a wider bar (30 chars) showing what % of the context
  // window is consumed. Color shifts green → yellow → red as it fills.
  const fillPct = contextWindow ? Math.round((filledTokens / contextWindow) * 100) : 0;
  const fillBarLen = 30;
  const fillFilled = contextWindow ? Math.min(fillBarLen, Math.round((filledTokens / contextWindow) * fillBarLen)) : 0;
  const fillBar = '█'.repeat(fillFilled) + '░'.repeat(fillBarLen - fillFilled);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.cyan} paddingLeft={1} paddingRight={1}>
      <Box>
        <Text color={theme.cyan} bold>Context</Text>
        <Text color={theme.fgDim}> — {model}</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        {parts.map((p) => {
          const filled = Math.round((p.tokens / maxTokens) * barLen);
          const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled);
          return (
            <Box key={p.label}>
              <Text color={theme.fgDim}>{p.label.padEnd(labelWidth)}</Text>
              <Text color={theme.cyan}> {bar} </Text>
              <Text color={theme.fg} bold>{String(p.tokens).padStart(6)}</Text>
              <Text color={theme.fgDim}> {p.detail}</Text>
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1}>
        <Text color={theme.fgDim}>{'Estimated total'.padEnd(labelWidth + barLen + 3)}</Text>
        <Text color={theme.fg} bold>{String(total).padStart(6)}</Text>
        <Text color={theme.fgDim}> tok</Text>
      </Box>

      {apiTokens !== undefined && (
        <Box>
          <Text color={theme.fgDim}>{'Last API request'.padEnd(labelWidth + barLen + 3)}</Text>
          <Text color={theme.green} bold>{String(apiTokens).padStart(6)}</Text>
          <Text color={theme.fgDim}> tok</Text>
        </Box>
      )}

      {contextWindow !== undefined && contextWindow > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Box>
            <Text color={theme.fgDim}>Window fill </Text>
            <Text color={fillPct >= 80 ? theme.red : fillPct >= 50 ? theme.yellow : theme.green}>
              {fillBar}
            </Text>
            <Text color={theme.fgDim}> </Text>
            <Text color={theme.fg} bold>{fmtContext(filledTokens, contextWindow)}</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
