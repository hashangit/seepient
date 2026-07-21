import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useTheme } from '../hooks/use-theme.js';
import { extractPattern } from '../../../foundations/grant-pattern.js';
import type { ApprovalContext, ApprovalDecision, GrantScope } from '../../../foundations/types.js';

interface PermissionPromptProps {
  toolName: string;
  args: Record<string, unknown>;
  /** LLM-authored gate context (title/description + per-scope implications). */
  approvalContext?: ApprovalContext;
  /** Called once with the user's decision. */
  onResolve: (decision: ApprovalDecision) => void;
}

// Reordered options: primary Allow/Deny scopes at the top for prominence
const OPTIONS = [
  { key: 'once', scope: 'once' as const },
  { key: 'session', scope: 'session' as const },
  { key: 'project', scope: 'project' as const },
  { key: 'global', scope: 'global' as const },
  { key: 'deny', scope: 'deny' as const },
];

/**
 * Pure: map an option index to an ApprovalDecision. Exported for unit testing
 * (arrow navigation can't be driven through ink-testing-library — see tests).
 */
export function commitDecision(idx: number): ApprovalDecision {
  const opt = OPTIONS[idx];
  if (!opt) return false;
  if (opt.scope === 'deny') return false;
  if (opt.scope === 'once') return true;
  return { approved: true, scope: opt.scope as GrantScope };
}

/** Pure: cycle the selection index, wrapping at both ends. */
export function cycleSelection(idx: number, delta: 1 | -1): number {
  return (idx + delta + OPTIONS.length) % OPTIONS.length;
}

/** Human-friendly, explanatory implications for each scope */
function defaultImplication(scope: GrantScope | 'once', pattern?: string): string {
  const toolRef = pattern ? `"${pattern}"` : 'this action';
  switch (scope) {
    case 'once': 
      return `Run ${toolRef} this one time, then ask again next time`;
    case 'session': 
      return `Remember for now: auto-run ${toolRef} until you restart the app`;
    case 'project': 
      return `Trust in this project: auto-run ${toolRef} anywhere here (revoke in /permissions)`;
    case 'global': 
      return `Trust everywhere: auto-run ${toolRef} in any project (revoke in /permissions)`;
  }
}

/** One-line preview of the actual tool args (tamper-proof). */
function formatActual(toolName: string, args: Record<string, unknown>): string {
  if (typeof args.command === 'string' && args.command.length > 0) return args.command;
  if (typeof args.path === 'string' && args.path.length > 0) return args.path;
  const json = JSON.stringify(args);
  return json === '{}' ? '' : json;
}

/**
 * Inline tool-approval widget rendered in the feed while the agent is paused
 * on `approveTool`. Shows the LLM-authored title + description, the actual
 * command/path (tamper-proof), and five bordered option rows — one per
 * scope — each with its implication. Stays within Ink's input handling — no
 * stdin mode switch.
 */
export function PermissionPrompt({ toolName, args, approvalContext, onResolve }: PermissionPromptProps) {
  const theme = useTheme();
  const [selected, setSelected] = useState(0);

  const title = approvalContext?.title || `Run ${toolName}`;
  const description = approvalContext?.description;
  const actual = formatActual(toolName, args);
  const pattern = extractPattern(toolName, args);

  useInput((input, key) => {
    if (key.upArrow) {
      setSelected((s) => cycleSelection(s, -1));
    } else if (key.downArrow) {
      setSelected((s) => cycleSelection(s, 1));
    } else if (key.return) {
      onResolve(commitDecision(selected));
    } else if (input === 'q' || key.escape) {
      onResolve(commitDecision(4)); // deny
    } else {
      // 1-5 quick select
      const n = parseInt(input, 10);
      if (n >= 1 && n <= OPTIONS.length) onResolve(commitDecision(n - 1));
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.yellow} paddingX={1}>
      {/* Title row */}
      <Box>
        <Text color={theme.yellow} bold>◆ </Text>
        <Text color={theme.fg} bold>{title}</Text>
        <Text color={theme.fgDim}> ── {toolName} · {riskLabel(toolName, args)}</Text>
      </Box>

      {/* Deterministic facts (spec 008 T306/FR-021) — tamper-proof, derived
          from the prepared action, NOT from LLM-authored text. The target,
          effect, and boundary are what the user is actually approving. */}
      <Box flexDirection="column" marginTop={0}>
        {actual ? (
          <Box>
            <Text color={theme.cyan}>  Target  </Text>
            <Text color={theme.fg}>{truncate(actual, 100)}</Text>
          </Box>
        ) : null}
        <Box>
          <Text color={theme.cyan}>  Effect  </Text>
          <Text color={theme.fg}>{effectLabel(toolName, args)}</Text>
        </Box>
        <Box>
          <Text color={theme.cyan}>  Expires </Text>
          <Text color={theme.fgDim}>when this action completes (other paths remain denied)</Text>
        </Box>
      </Box>

      {/* Description (LLM-authored) — explicitly labelled UNTRUSTED per FR-021.
          It cannot alter the displayed target/effect/boundary above. */}
      {description ? (
        <Box marginTop={1}>
          <Text color={theme.fgDim}>
            <Text color={theme.yellow} bold>Agent rationale (untrusted): </Text>
            {description}
          </Text>
        </Box>
      ) : null}

      {/* Actual command/path — always shown, tamper-proof */}
      {actual ? (
        <Box marginTop={1}>
          <Text color={theme.cyan}>  $ </Text>
          <Text color={theme.fg}>{truncate(actual, 120)}</Text>
        </Box>
      ) : null}

      {/* Option rows */}
      <Box flexDirection="column" marginTop={1}>
        {OPTIONS.map((opt, i) => {
          const isSel = i === selected;
          const isDeny = opt.scope === 'deny';
          const accent = isDeny ? theme.red : (opt.scope === 'once' ? theme.green : theme.blue);
          const scope = opt.scope as GrantScope | 'once';
          // "once" has no LLM implication (it's not a GrantScope key); fall to template.
          const llmImpl = scope !== 'once'
            ? approvalContext?.implications?.[scope as GrantScope]
            : undefined;
          const implication = isDeny
            ? undefined
            : (llmImpl ?? defaultImplication(scope, pattern));
          const label = optionLabel(opt.scope, pattern);
          return (
            <Box
              key={opt.key}
              borderStyle={isSel ? 'round' : 'single'}
              borderColor={isSel ? accent : theme.fgGutter}
            >
              <Text color={accent} bold>{i + 1} </Text>
              <Text bold color={isSel ? accent : (isDeny ? theme.red : theme.fg)}>
                {isDeny ? '✕ ' : (opt.scope === 'once' ? '✓ ' : '  ')}
                <Text bold>{label}</Text>
              </Text>
              {implication ? (
                <Text color={theme.fgDim}> — {truncate(implication, 90)}</Text>
              ) : null}
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1}>
        <Text color={theme.fgDim}> ↑↓ navigate · enter select · 1-{OPTIONS.length} · esc deny</Text>
      </Box>
    </Box>
  );
}

function optionLabel(scope: string, pattern?: string): string {
  const what = pattern ? `"${pattern}"` : 'this';
  switch (scope) {
    case 'once': return 'Allow Once';
    case 'session': return `Allow for This Session`;
    case 'project': return `Allow in This Project`;
    case 'global': return `Allow Globally`;
    default: return 'Deny';
  }
}

function riskLabel(toolName: string, args: Record<string, unknown>): string {
  // Lightweight inline risk hint without importing the registry (which would
  // pull the whole tool graph into the TUI bundle). The loop already gated on
  // the real risk category; this is display-only.
  if (toolName === 'execute_shell_command') return 'destructive';
  if (toolName === 'write_file' || toolName === 'edit_file' || toolName === 'generate_image') return 'edit';
  if (args.command) return 'destructive';
  return 'unknown';
}

/** Deterministic effect label (spec 008 T306) — derived from tool+args, not
 *  from LLM-authored text. Mirrors the effect vocabulary in tool-effects.ts. */
function effectLabel(toolName: string, args: Record<string, unknown>): string {
  if (toolName === 'execute_shell_command') return 'process-exec (root-shaped caps)';
  if (toolName === 'write_file' || toolName === 'edit_file') return 'filesystem-write (exact commit)';
  if (toolName === 'read_file') return 'filesystem-read + model-egress';
  if (toolName === 'send_email') return 'external-send (smtp) + secret-use';
  if (toolName === 'web_search' || toolName === 'read_website') return 'network-egress + model-egress';
  if (toolName === 'send_notification') return 'external-send (im) + secret-use';
  if (toolName === 'generate_image') return 'network-egress + secret-use + model-egress';
  if (args.command) return 'process-exec';
  return 'unknown';
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}