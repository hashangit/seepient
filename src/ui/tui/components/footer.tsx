import { Box, Text } from 'ink';
import { useTheme } from '../hooks/use-theme.js';
import type { CumulativeUsage } from '../../../foundations/types.js';

interface FooterProps {
  providerType: string;
  model: string;
  usage: CumulativeUsage;
  consentMode?: string;
  skillCount: number;
  gatewayOn: boolean;
  mcpCount: number;
  /** Context-window fill level: prompt tokens of the last request = full conversation size. */
  contextTokens: number;
  /** The active model's max context in tokens (undefined if unknown). */
  contextWindow?: number;
}

/** "12k/200k (6%)" when the limit is known, else just the used amount. */
function fmtContext(used: number, limit?: number): string {
  if (!limit) return `${Math.round(used / 1000)}k`;
  const pct = Math.round((used / limit) * 100);
  return `${Math.round(used / 1000)}k/${Math.round(limit / 1000)}k (${pct}%)`;
}

/**
 * Fixed bottom status bar: provider | model | context-window | cost | consent mode
 * | skills | gw. Context-window + cost update live from the agent's usage.
 */
export function Footer({
  providerType, model, usage, consentMode, skillCount, gatewayOn, mcpCount, contextTokens, contextWindow,
}: FooterProps) {
  const theme = useTheme();
  const sep = <Text color={theme.fgGutter}> │ </Text>;
  const activeMode = consentMode ?? 'edit-enabled';
  return (
    <Box>
      <Text color={theme.purple}>{providerType}</Text>
      {sep}
      <Text color={theme.cyan}>{model}</Text>
      {sep}
      <Text color={theme.fgDim}>{fmtContext(contextTokens, contextWindow)}</Text>
      {sep}
      <Text color={theme.fgDim}>${usage.totalCost.toFixed(2)}</Text>
      {sep}
      <Text color={activeMode === 'autonomous' ? theme.yellow : theme.fgDim}>mode: {activeMode}</Text>
      {sep}
      <Text color={theme.fgDim}>{skillCount} skills</Text>
      {sep}
      <Text color={gatewayOn ? theme.green : theme.fgDim}>gw: {gatewayOn ? `on (${mcpCount})` : 'off'}</Text>
    </Box>
  );
}
