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
  /** Commit-helper state from the startup preflight (spec 019 FR-010). */
  exactCommit?: boolean;
  exactCommitReason?: string;
}

/** "12k/200k (6%)" when the limit is known, else just the used amount. */
function fmtContext(used: number, limit?: number): string {
  if (!limit) return `${Math.round(used / 1000)}k`;
  const pct = Math.round((used / limit) * 100);
  return `${Math.round(used / 1000)}k/${Math.round(limit / 1000)}k (${pct}%)`;
}

/** Closed status mapping: on | off (helper missing) | off (digest mismatch). */
export function formatExactCommits(exactCommit?: boolean, reason?: string): string {
  if (exactCommit === undefined) return 'exact commits: unknown';
  if (exactCommit) return 'exact commits: on';
  if (reason === 'digest-mismatch') return 'exact commits: off (digest mismatch)';
  return 'exact commits: off (helper missing)';
}

/**
 * Fixed bottom status bar: provider | model | context-window | cost | consent mode
 * | skills | gw | exact commits. Context-window + cost update live from the agent's usage.
 */
export function Footer({
  providerType, model, usage, consentMode, skillCount, gatewayOn, mcpCount, contextTokens, contextWindow,
  exactCommit, exactCommitReason,
}: FooterProps) {
  const theme = useTheme();
  const sep = <Text color={theme.fgGutter}> │ </Text>;
  const activeMode = consentMode ?? 'edit-enabled';
  const exactCommitsOn = exactCommit === true;
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
      {sep}
      <Text color={exactCommitsOn ? theme.green : theme.yellow}>{formatExactCommits(exactCommit, exactCommitReason)}</Text>
    </Box>
  );
}
