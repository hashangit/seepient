import { useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useTheme } from '../hooks/use-theme.js';
import { extractPattern } from '../../../foundations/grant-pattern.js';
import type {
  ApprovalOption,
  PermissionRequest,
  TuiApprovalSelection,
} from '../../../foundations/contracts/permission-policy.js';
import type { ApprovalContext, ApprovalDecision, GrantScope } from '../../../foundations/types.js';

// ══════════════════════════════════════════════════════════════════════════
// Native (spec 011) prompt — typed PermissionRequest flow
// ══════════════════════════════════════════════════════════════════════════

export type PromptTab = 'scope' | 'duration';

/**
 * The MVP offers only `action`/`session` durations, supported by both the
 * request and the selected option (FR-010).
 */
export function visibleLifetimes(
  option: ApprovalOption,
  request?: PermissionRequest,
): Array<'action' | 'session'> {
  return option.supportedLifetimes.filter(
    (l): l is 'action' | 'session' =>
      (l === 'action' || l === 'session') &&
      (request === undefined || request.offeredLifetimes.includes(l)),
  );
}

/** Least-privilege default scope: exact when offered, else narrowest option. */
export function defaultScopeIndex(options: ApprovalOption[]): number {
  const exact = options.findIndex((o) => o.kind === 'exact');
  return exact >= 0 ? exact : 0;
}

/** Least-privilege default duration: Allow Once when offered. */
export function defaultLifetimeIndex(lifetimes: Array<'action' | 'session'>): number {
  const action = lifetimes.indexOf('action');
  return action >= 0 ? action : 0;
}

/**
 * Build the strict `TuiApprovalSelection` from the visible pair. Stale or
 * out-of-range indices are clamped to the visible set; a request with no
 * representable options can only deny as unavailable (FR-005).
 */
export function buildSelection(
  request: PermissionRequest,
  scopeIdx: number,
  lifetimeIdx: number,
): TuiApprovalSelection {
  const options = request.approvalOptions;
  if (options.length === 0) return { approved: false, reason: 'approval-unavailable' };
  const option = options[Math.min(Math.max(scopeIdx, 0), options.length - 1)];
  const lifetimes = visibleLifetimes(option, request);
  if (lifetimes.length === 0) return { approved: false, reason: 'approval-unavailable' };
  const lifetime = lifetimes[Math.min(Math.max(lifetimeIdx, 0), lifetimes.length - 1)];
  return { approved: true, optionId: option.optionId, lifetime };
}

/** Pure: move within the visible list without wrapping (FR-015). */
export function clampMove(idx: number, delta: 1 | -1, size: number): number {
  if (size <= 1) return 0;
  return Math.min(Math.max(idx + delta, 0), size - 1);
}

const DURATION_LABELS: Record<'action' | 'session', string> = {
  action: 'Allow Once',
  session: 'This Session',
};

interface NativePermissionPromptProps {
  /** Immutable policy-issued request; the prompt renders it as-is. */
  request: PermissionRequest;
  /** Called once with the transient selection or denial. */
  onResolve: (selection: TuiApprovalSelection) => void;
}

/**
 * Native inline tool-approval widget (spec 011). Two tabs — Scope (policy-
 * issued exact/bounded options) and Duration (Allow Once / This Session) —
 * with keyboard navigation, least-privilege defaults, and a visible summary
 * of the selected pair. The component owns ONLY transient tab/selection
 * state; it emits the strict `TuiApprovalSelection` and never invents
 * authority from raw tool arguments.
 */
export function PermissionPrompt({ request, onResolve }: NativePermissionPromptProps) {
  const theme = useTheme();
  const options = request.approvalOptions;
  // State mirrors through refs (CLAUDE.md §6): the useInput handler is
  // long-lived across renders, so it must read the CURRENT selection — a
  // stale closure could submit the wrong pair under rapid keypresses.
  const [tab, setTabState] = useState<PromptTab>('scope');
  const tabRef = useRef<PromptTab>('scope');
  const [scopeIdx, setScopeIdxState] = useState(() => defaultScopeIndex(options));
  const scopeIdxRef = useRef(scopeIdx);
  const [lifetimeIdx, setLifetimeIdxState] = useState(() => {
    const first = options[defaultScopeIndex(options)];
    return defaultLifetimeIndex(first ? visibleLifetimes(first, request) : []);
  });
  const lifetimeIdxRef = useRef(lifetimeIdx);

  const setTab = (t: PromptTab): void => {
    tabRef.current = t;
    setTabState(t);
  };
  const setScopeIdx = (i: number): void => {
    scopeIdxRef.current = i;
    setScopeIdxState(i);
  };
  const setLifetimeIdx = (i: number): void => {
    lifetimeIdxRef.current = i;
    setLifetimeIdxState(i);
  };

  // Current visible pair — clamped so a stale index (new request or a
  // narrower option) can never select a nonexistent item.
  const option = options[Math.min(Math.max(scopeIdx, 0), options.length - 1)];
  const lifetimes = option ? visibleLifetimes(option, request) : [];
  const lifetime = lifetimes[Math.min(Math.max(lifetimeIdx, 0), lifetimes.length - 1)];

  useInput((input, key) => {
    // Tab / Shift+Tab (key.tab with key.shift) and Left/Right switch tabs
    // (FR-014). With two tabs, direction is symmetric.
    const currentTab = tabRef.current;
    if (key.tab || key.rightArrow || key.leftArrow) {
      setTab(currentTab === 'scope' ? 'duration' : 'scope');
    } else if (key.upArrow) {
      if (currentTab === 'scope') setScopeIdx(clampMove(scopeIdxRef.current, -1, options.length));
      else setLifetimeIdx(clampMove(lifetimeIdxRef.current, -1, lifetimes.length));
    } else if (key.downArrow) {
      if (currentTab === 'scope') setScopeIdx(clampMove(scopeIdxRef.current, 1, options.length));
      else setLifetimeIdx(clampMove(lifetimeIdxRef.current, 1, lifetimes.length));
    } else if (key.return) {
      onResolve(buildSelection(request, scopeIdxRef.current, lifetimeIdxRef.current));
    } else if (key.escape || input === 'q') {
      onResolve({ approved: false, reason: 'user-denied' });
    } else if (/^[0-9]$/.test(input)) {
      const n = parseInt(input, 10);
      if (currentTab === 'scope' && n >= 1 && n <= options.length) {
        setScopeIdx(n - 1);
      } else if (currentTab === 'duration' && n >= 1 && n <= lifetimes.length) {
        setLifetimeIdx(n - 1);
      }
    }
    // Unsupported keys have no effect.
  });

  const scopeColor = tab === 'scope' ? theme.yellow : theme.fgGutter;
  const durationColor = tab === 'duration' ? theme.yellow : theme.fgGutter;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.yellow} paddingX={1}>
      {/* Title row — request identity + action summary (tamper-proof). */}
      <Box>
        <Text color={theme.yellow} bold>◆ </Text>
        <Text color={theme.fg} bold>{request.action.title}</Text>
        <Text color={theme.fgDim}> ── {request.action.effects.join(', ') || 'no effects'}</Text>
      </Box>
      <Box>
        <Text color={theme.cyan}>  Request </Text>
        <Text color={theme.fg}>{request.requestId.slice(0, 8)}…</Text>
        <Text color={theme.fgDim}>
          {' '}· expires {new Date(request.expiresAt).toLocaleTimeString()}
        </Text>
      </Box>
      {request.action.summary ? (
        <Box>
          <Text color={theme.cyan}>  Summary </Text>
          <Text color={theme.fg}>{truncate(request.action.summary, 100)}</Text>
        </Box>
      ) : null}

      {/* Tabs */}
      <Box marginTop={1}>
        <Text color={scopeColor} bold>
          {tab === 'scope' ? '▸' : ' '} [1] Scope
        </Text>
        <Text>  </Text>
        <Text color={durationColor} bold>
          {tab === 'duration' ? '▸' : ' '} [2] Duration
        </Text>
      </Box>

      {/* Scope tab — only the options supplied by Domain. */}
      {tab === 'scope' ? (
        <Box flexDirection="column" marginTop={1}>
          {options.map((opt, i) => {
            const isSel = i === scopeIdx;
            const accent = opt.kind === 'exact' ? theme.green : theme.blue;
            return (
              <Box key={opt.optionId} borderStyle={isSel ? 'round' : 'single'} borderColor={isSel ? accent : theme.fgGutter}>
                <Text color={accent} bold>{i + 1} </Text>
                <Text bold color={isSel ? accent : theme.fg}>
                  {isSel ? '✓ ' : '  '}
                  <Text color={theme.fgDim}>{opt.kind === 'exact' ? '[exact]' : '[bounded]'} </Text>
                  {truncate(opt.label, 90)}
                </Text>
              </Box>
            );
          })}
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {lifetimes.map((l, i) => {
            const isSel = i === lifetimeIdx;
            const accent = theme.green;
            return (
              <Box key={l} borderStyle={isSel ? 'round' : 'single'} borderColor={isSel ? accent : theme.fgGutter}>
                <Text color={accent} bold>{i + 1} </Text>
                <Text bold color={isSel ? accent : theme.fg}>
                  {isSel ? '✓ ' : '  '}
                  {DURATION_LABELS[l]}
                  {l === 'session' ? ' (until the app session ends)' : ' (this one action)'}
                </Text>
              </Box>
            );
          })}
        </Box>
      )}

      {/* Summary of the selected pair — always visible. */}
      <Box marginTop={1}>
        <Text color={theme.cyan}>  Selected </Text>
        <Text color={theme.fg}>{option ? truncate(option.label, 60) : '—'}</Text>
        <Text color={theme.fgDim}> · </Text>
        <Text color={theme.fg}>{lifetime ? DURATION_LABELS[lifetime] : '—'}</Text>
      </Box>

      <Box marginTop={1}>
        <Text color={theme.fgDim}>
          {' '}tab/←→ switch · ↑↓ move · 1-{Math.max(options.length, lifetimes.length)} select · enter approve · esc/q deny
        </Text>
      </Box>
    </Box>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Legacy (flag-off) prompt — unchanged behavior, not part of 011 evidence
// ══════════════════════════════════════════════════════════════════════════

interface LegacyPermissionPromptProps {
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
 * Legacy inline tool-approval widget — the `--permission-pipeline`-off
 * fallback. Kept byte-for-byte behavior; it is not part of 011's acceptance
 * evidence (spec 011 scope & boundary).
 */
export function LegacyPermissionPrompt({ toolName, args, approvalContext, onResolve }: LegacyPermissionPromptProps) {
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
