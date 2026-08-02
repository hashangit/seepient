/**
 * Seepient CLI — /permissions Command Handler
 *
 * Lists and manages persisted tool-approval grants (session/project/global).
 * Read-only listing works in both the TUI and readline (returns `output`).
 *
 * Legacy grant subcommands (session-scoped rememberings):
 *   /permissions                    — list all grants grouped by scope
 *   /permissions clear <scope>      — remove all grants at a scope
 *                                     (scope: session | project | global)
 *   /permissions revoke <id>        — remove a single grant by id prefix
 *
 * Spec 008 protected-policy subcommands (T307, FR-013/FR-021) — route through
 * the protected PolicyStore via compare-and-set, never through an effectful
 * tool or a worktree file:
 *   /permissions status            — show enforcement mode, backend shapes,
 *                                    immutable denies, protected policy
 *                                    location/version
 *   /permissions propose <cap>     — propose a project/global capability
 *                                    (inactive until approved)
 *   /permissions review            — list pending proposals
 *   /permissions approve <id>      — approve a proposal (writes protected
 *                                    policy outside executor roots)
 *   /permissions revoke-cap <id>   — revoke an approved capability
 *   /permissions help               — usage
 */

import chalk from 'chalk';
import type { GrantScope } from '../../../foundations/types.js';
import type { CommandHandler } from './registry.js';
import type { Capability, CapabilitySet } from '../../../foundations/contracts/permission-policy.js';
import type { PolicyStore } from '../../../foundations/contracts/execution-brokers.js';
import { GLOBAL_WORKSPACE_ID } from '../../../domain/permissions/policy-store.js';

const SCOPES: GrantScope[] = ['session', 'project', 'global'];

function usage(): string {
  return [
    chalk.bold.cyan('Usage: /permissions [subcommand]'),
    '',
    chalk.dim('Legacy grants (session rememberings):'),
    `  ${chalk.green('/permissions')}                List all grants grouped by scope`,
    `  ${chalk.green('/permissions clear')} ${chalk.dim('<scope>')}     Remove all grants at a scope (session|project|global)`,
    `  ${chalk.green('/permissions revoke')} ${chalk.dim('<id-prefix>')} Remove a single grant by id (prefix match)`,
    '',
    chalk.dim('Protected policy (spec 008 — trusted administrative flow):'),
    `  ${chalk.green('/permissions status')}            Show enforcement + protected policy state`,
    `  ${chalk.green('/permissions propose')} ${chalk.dim('<kind>:<target>')}  Propose a capability (inactive until approved)`,
    `  ${chalk.green('/permissions review')}            List pending proposals`,
    `  ${chalk.green('/permissions approve')} ${chalk.dim('<id>')}     Approve a proposal (writes protected policy)`,
    `  ${chalk.green('/permissions revoke-cap')} ${chalk.dim('<id>')}  Revoke an approved capability`,
    `  ${chalk.green('/permissions revoke-global')} ${chalk.dim('<idx>')}  Revoke a global ("Allow always") capability`,
    `  ${chalk.green('/permissions help')}           Show this help`,
    '',
    chalk.dim('Proposals are inactive. Approval writes active policy outside executor roots'),
    chalk.dim('via PolicyStore.compareAndSet — never through an effectful tool.'),
  ].join('\n');
}

/** Parse a capability spec like "commit-file:/proj/a.txt" or "read-root:/proj". */
function parseCapabilitySpec(spec: string): Capability | { error: string } {
  const idx = spec.indexOf(":");
  if (idx === -1) return { error: `Expected "<kind>:<target>", got "${spec}"` };
  const kind = spec.slice(0, idx);
  const target = spec.slice(idx + 1);
  switch (kind) {
    case "commit-file":
    case "read-file":
      return { kind, path: target };
    case "read-root":
    case "write-root":
      return { kind, root: target };
    case "secret-ref":
      return { kind, ref: target };
    default:
      return { error: `Unsupported capability kind for proposal: ${kind}` };
  }
}

/** Format a capability for display. */
function describeCapability(cap: Capability): string {
  switch (cap.kind) {
    case "commit-file":
    case "read-file":
      return `${cap.kind}:${cap.path}`;
    case "read-root":
    case "write-root":
      return `${cap.kind}:${cap.root}`;
    case "network-destination":
      return `network:${cap.scheme}://${cap.host}${cap.port ? `:${cap.port}` : ""}`;
    case "external-recipient":
      return `send:${cap.service}:${cap.recipient}`;
    case "process":
      return `process:${cap.executable ?? "*"}`;
    case "secret-ref":
      return `secret:${cap.ref}`;
    case "trusted-host":
      return `trusted-host:${cap.registrationId ?? "*"}`;
    case "activate-change-class":
      return `activate:${cap.changeClass}`;
    default:
      return (cap as any).kind ?? "unknown";
  }
}

export const permissionsHandler: CommandHandler = async (ctx) => {
  const store = ctx.agent.getGrantStore?.();
  const policyStore = ctx.agent.getPolicyStore?.();
  const parts = ctx.args.trim().split(/\s+/).filter(Boolean);
  const sub = parts[0]?.toLowerCase();

  // Spec 008 protected-policy subcommands (T307). These route exclusively
  // through PolicyStore.compareAndSet — never through an effectful tool or
  // a worktree file. Requires the protected policy store to be configured.
  if (sub === 'status') {
    return {
      output: await renderStatus(
        store,
        policyStore,
        ctx.agent.getContainmentStatus?.(),
        ctx.agent.getActiveCapabilities?.(),
        ctx.agent.getPolicyWorkspaceId?.(),
      ),
    };
  }

  if (sub === 'propose') {
    if (!policyStore) return noPolicyStore();
    const spec = parts[1];
    if (!spec) return { output: chalk.red('Usage: /permissions propose <kind>:<target>') };
    const parsed = parseCapabilitySpec(spec);
    if ("error" in parsed) return { output: chalk.red(parsed.error) };
    // A proposal is inert: it's staged in-memory for /permissions review +
    // approve. Only approve writes active policy via compare-and-set.
    const proposalId = await ctx.agent.stagePolicyProposal?.(parsed);
    return {
      output: chalk.green(`Staged proposal ${chalk.cyan(proposalId ?? "?")} for ${chalk.cyan(describeCapability(parsed))}.
${chalk.dim('Inactive. Use /permissions review + /permissions approve to activate.')}`),
    };
  }

  if (sub === 'review') {
    const proposals = ctx.agent.listPolicyProposals?.() ?? [];
    if (proposals.length === 0) {
      return { output: chalk.dim('No pending capability proposals.') };
    }
    const lines = [chalk.bold.cyan('Pending Capability Proposals'), ''];
    for (const p of proposals) {
      lines.push(`  ${chalk.cyan(p.id)}  ${describeCapability(p.capability)}`);
    }
    lines.push('', chalk.dim('Activate with: /permissions approve <id>'));
    return { output: lines.join('\n') };
  }

  if (sub === 'approve') {
    if (!policyStore) return noPolicyStore();
    const id = parts[1];
    if (!id) return { output: chalk.red('Usage: /permissions approve <proposal-id>') };
    const proposals = ctx.agent.listPolicyProposals?.() ?? [];
    const match = proposals.filter((p) => p.id.startsWith(id));
    if (match.length === 0) return { output: chalk.yellow(`No proposal matching "${id}".`) };
    if (match.length > 1) return { output: chalk.yellow(`Ambiguous prefix "${id}".`) };
    try {
      const snap = await ctx.agent.approvePolicyProposal?.(match[0].id);
      return {
        output: chalk.green(`Approved ${chalk.cyan(match[0].id)} → active policy version ${snap?.version ?? "?"}.
${chalk.dim('Effective on the next evaluation. Stored outside executor roots.')}`),
      };
    } catch (err) {
      return { output: chalk.red(`Approval failed: ${(err as Error).message}`) };
    }
  }

  if (sub === 'revoke-cap') {
    if (!policyStore) return noPolicyStore();
    const idx = parts[1];
    if (!idx) return { output: chalk.red('Usage: /permissions revoke-cap <index>') };
    try {
      const snap = await ctx.agent.revokePolicyCapability?.(Number(idx));
      return { output: chalk.green(`Revoked capability at index ${idx} → version ${snap?.version ?? "?"}.`) };
    } catch (err) {
      return { output: chalk.red(`Revoke failed: ${(err as Error).message}`) };
    }
  }

  if (sub === 'revoke-global') {
    if (!policyStore) return noPolicyStore();
    const idx = parts[1];
    if (!idx) return { output: chalk.red('Usage: /permissions revoke-global <index>') };
    try {
      const snap = await ctx.agent.revokeGlobalPolicyCapability?.(Number(idx));
      return { output: chalk.green(`Revoked GLOBAL capability at index ${idx} → version ${snap?.version ?? "?"}.`) };
    } catch (err) {
      return { output: chalk.red(`Revoke failed: ${(err as Error).message}`) };
    }
  }

  if (!store) {
    return { output: chalk.yellow('No grant store available (grants are CLI-only).') };
  }

  // /permissions  (no sub) — list all
  if (!sub || sub === 'list') {
    return { output: renderGrants(store.list()) };
  }

  if (sub === 'help') {
    return { output: usage() };
  }

  if (sub === 'clear') {
    const scope = parts[1]?.toLowerCase() as GrantScope;
    if (!SCOPES.includes(scope)) {
      return { output: `${chalk.red('Invalid scope.')} Use: ${chalk.cyan('session | project | global')}` };
    }
    await store.clear(scope);
    return { output: chalk.green(`Cleared all ${scope} grants.`) };
  }

  if (sub === 'revoke') {
    const idPrefix = parts[1];
    if (!idPrefix) {
      return { output: chalk.red('Usage: /permissions revoke <id-prefix>') };
    }
    // Find by id prefix (full ids are long UUIDs)
    const all = store.list();
    const match = all.filter((g) => g.id.startsWith(idPrefix));
    if (match.length === 0) {
      return { output: chalk.yellow(`No grant matching "${idPrefix}".`) };
    }
    if (match.length > 1) {
      return { output: chalk.yellow(`Ambiguous prefix "${idPrefix}" — matches ${match.length} grants. Use more characters.`) };
    }
    await store.remove(match[0].id);
    return { output: chalk.green(`Revoked grant: ${describeGrant(match[0])}`) };
  }

  return { output: `${chalk.red(`Unknown subcommand: ${sub}`)}\n\n${usage()}` };
};

function noPolicyStore(): { output: string } {
  return {
    output: chalk.yellow(
      'Protected policy store not configured for this surface. The spec 008 pipeline\nis opt-in; use the action-lifecycle flag to enable protected policy.',
    ),
  };
}

async function renderStatus(
  store: { list(): Array<{ scope: string }> } | null | undefined,
  policyStore: PolicyStore | null | undefined,
  containment: import("../../../capabilities/execution/containment-preflight.js").ContainmentPreflightResult | undefined,
  active: Capability[] | undefined,
  agentWorkspaceId: string | null | undefined,
): Promise<string> {
  const lines: string[] = [chalk.bold.cyan('Permission Status (spec 008)'), ''];
  lines.push(`${chalk.bold('Containment (spec 011 preflight):')}`);
  if (containment?.ok) {
    lines.push(`  ${chalk.green('active')} — backend ${chalk.cyan(containment.backend)}`);
    if (containment.workspaceRoot) {
      lines.push(`  writable workspace root: ${chalk.cyan(containment.workspaceRoot)}`);
    }
  } else if (containment) {
    lines.push(chalk.yellow(`  unavailable (${containment.reason})`));
    lines.push(chalk.dim(`  ${containment.setupHint}`));
    if (process.env.SEEPIENT_UNCONTAINED === '1') {
      lines.push(chalk.dim('  NOTE: SEEPIENT_UNCONTAINED=1 is set — process actions run UNCONTAINED with explicit operator opt-in (audit records isolated:false).'));
    }
  } else {
    lines.push(chalk.dim('  (pipeline not enabled on this surface)'));
  }
  lines.push('');
  lines.push(`${chalk.bold('Active session authority (spec 011):')}`);
  if (active && active.length > 0) {
    for (const cap of active) {
      lines.push(`  ${chalk.green(describeCapability(cap))}`);
    }
    lines.push(chalk.dim('  Session approvals are held in memory for this session; they are not grants.'));
  } else {
    lines.push(chalk.dim('  (none — action approvals are consumed once; session approvals appear here)'));
  }
  lines.push('');
  lines.push(`${chalk.bold('Legacy grants:')}`);
  if (store) {
    const counts: Record<string, number> = { session: 0, project: 0, global: 0 };
    for (const g of store.list()) counts[g.scope] = (counts[g.scope] ?? 0) + 1;
    lines.push(`  session: ${counts.session}, project: ${counts.project}, global: ${counts.global}`);
  } else {
    lines.push(chalk.dim('  (no grant store on this surface)'));
  }
  lines.push('');
  lines.push(`${chalk.bold('Protected policy:')}`);
  if (policyStore) {
    lines.push(chalk.dim('  configured — use /permissions review for proposals'));
    if (agentWorkspaceId) {
      const projectSnap = await policyStore.read(agentWorkspaceId).catch(() => null);
      if (projectSnap && projectSnap.policy.capabilities.length > 0) {
        lines.push(chalk.bold('  Project policy:'));
        for (const cap of projectSnap.policy.capabilities) {
          lines.push(`    ${chalk.green(describeCapability(cap))}`);
        }
      }
    }
    const globalSnap = await policyStore.read(GLOBAL_WORKSPACE_ID).catch(() => null);
    if (globalSnap && globalSnap.policy.capabilities.length > 0) {
      lines.push(chalk.bold('  Global policy ("Allow always" grants):'));
      for (const cap of globalSnap.policy.capabilities) {
        lines.push(`    ${chalk.green(describeCapability(cap))}`);
      }
      lines.push(chalk.dim('    Revoke: /permissions revoke-global <index>'));
    } else {
      lines.push(chalk.dim('  Global policy: (none)'));
    }
  } else {
    lines.push(chalk.dim('  (not configured — protected policy is opt-in)'));
  }
  return lines.join('\n');
}

function renderGrants(grants: { id: string; tool: string; pattern?: string; scope: string; createdAt: number }[]): string {
  if (grants.length === 0) {
    return `${chalk.dim('No permission grants. Approve a tool with a scope beyond "once" to create one.')}
${chalk.dim('Note: native pipeline session approvals are NOT stored as grants — run /permissions status to see active session authority.')}`;
  }

  const lines: string[] = [chalk.bold.cyan('Permission Grants'), ''];

  for (const scope of SCOPES) {
    const subset = grants.filter((g) => g.scope === scope);
    lines.push(chalk.bold(`${capitalize(scope)} (${subset.length})`));
    if (subset.length === 0) {
      lines.push(chalk.dim('  (none)'));
    } else {
      for (const g of subset) {
        lines.push(`  ${describeGrant(g)}`);
      }
    }
    lines.push('');
  }

  lines.push(chalk.dim('Revoke: /permissions revoke <id-prefix>  ·  Clear: /permissions clear <scope>'));
  return lines.join('\n');
}

function describeGrant(g: { id: string; tool: string; pattern?: string; createdAt: number }): string {
  const id = g.id.slice(0, 8);
  const pat = g.pattern ? chalk.cyan(g.pattern) : chalk.dim('(any args)');
  return `${chalk.green(g.tool)} ${pat} ${chalk.dim(`[${id}]`)}`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
