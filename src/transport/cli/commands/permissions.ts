/**
 * Seepient CLI — /permissions Command Handler
 *
 * Shows consolidated native authority/policy status and manages persisted
 * tool-approval grants. Read-only listing works in both the TUI and readline.
 *
 * Legacy grant subcommands (session-scoped rememberings):
 *   /permissions list               — list all legacy grants grouped by scope
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
import type { PolicyStore, PolicySnapshot } from '../../../foundations/contracts/execution-brokers.js';
import { GLOBAL_WORKSPACE_ID, GLOBAL_WORKSPACE_ROOT } from '../../../domain/permissions/policy-store.js';
import type { ContainmentPreflightResult } from '../../../capabilities/execution/containment-preflight.js';
import { capabilityKey } from '../../../domain/permissions/capability-store.js';
import { createSettingsManager } from './settings.js';

const SCOPES: GrantScope[] = ['session', 'project', 'global'];

function usage(): string {
  return [
    chalk.bold.cyan('Usage: /permissions [subcommand]'),
    '',
    `  ${chalk.green('/permissions')}                     Show permissions by scope`,
    `  ${chalk.green('/permissions status')}              Same as /permissions (human-friendly view)`,
    `  ${chalk.green('/permissions revoke')} ${chalk.dim('<scope> <permission-number>')} Remove a listed permission (session|project|always)`,
    `  ${chalk.green('/permissions autonomous on')}       Show the autonomous-mode warning`,
    `  ${chalk.green('/permissions autonomous off')}      Disable autonomous mode`,
    `  ${chalk.green('/permissions diagnostics')}         Show technical enforcement details`,
    '',
    chalk.dim('Legacy grants (session rememberings):'),
    `  ${chalk.green('/permissions list')}           List legacy grants grouped by scope`,
    `  ${chalk.green('/permissions clear')} ${chalk.dim('<scope>')}     Remove all grants at a scope (session|project|global)`,
    `  ${chalk.green('/permissions revoke')} ${chalk.dim('<grant-id-prefix>')} Remove a single grant by id (prefix match)`,
    '',
    chalk.dim('Protected policy (spec 008 — trusted administrative flow):'),
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

/** Parse a capability spec like "commit-file:/proj/a.txt", "network-destination:https://api.github.com", or "process". */
function parseCapabilitySpec(spec: string): Capability | { error: string } {
  if (spec.trim() === "process") {
    return { kind: "process" };
  }
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
    case "model-egress":
      return { kind: "model-egress", providerClass: target, dataClasses: ["normal"] };
    case "external-recipient": {
      const subIdx = target.indexOf(":");
      if (subIdx === -1) {
        return { kind: "external-recipient", service: "*", recipient: target };
      }
      return {
        kind: "external-recipient",
        service: target.slice(0, subIdx),
        recipient: target.slice(subIdx + 1),
      };
    }
    case "network-destination": {
      let scheme: "http" | "https" = "https";
      let host = target;
      let port: number | undefined;
      if (target.startsWith("https://")) {
        scheme = "https";
        host = target.slice(8);
      } else if (target.startsWith("http://")) {
        scheme = "http";
        host = target.slice(7);
      }
      const slashIdx = host.indexOf("/");
      if (slashIdx !== -1) host = host.slice(0, slashIdx);
      const portIdx = host.indexOf(":");
      if (portIdx !== -1) {
        port = parseInt(host.slice(portIdx + 1), 10);
        host = host.slice(0, portIdx);
      }
      return { kind: "network-destination", scheme, host, port };
    }
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
      return `${cap.kind}:${cap.root === GLOBAL_WORKSPACE_ROOT ? "<current-workspace>" : cap.root}`;
    case "network-destination":
      return `network:${cap.scheme}://${cap.host}${cap.port ? `:${cap.port}` : ""}`;
    case "external-recipient":
      return `send:${cap.service}:${cap.recipient}`;
    case "process":
      return [
        `process:${cap.executable ?? "*"}`,
        ...(cap.argvPrefix ?? []).map((arg) => JSON.stringify(arg)),
        ...(cap.argvExact ? ["(exact)"] : []),
      ].join(" ");
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
  const policyStore = ctx.agent.getPolicyStore?.();
  const parts = ctx.args.trim().split(/\s+/).filter(Boolean);
  const sub = parts[0]?.toLowerCase();

  // Spec 008 protected-policy subcommands (T307). These route exclusively
  // through PolicyStore.compareAndSet — never through an effectful tool or
  // a worktree file. Requires the protected policy store to be configured.
  if (!sub || sub === 'status') {
    return {
      output: await renderPermissions(
        policyStore,
        ctx.agent.getActiveCapabilities?.(),
        ctx.agent.getPolicyWorkspaceId?.(),
        ctx.agent.getWorkspaceRoot?.(),
        ctx.agent.isAutonomousMode?.() ?? false,
        ctx.agent,
      ),
    };
  }

  if (sub === 'diagnostics') {
    return {
      output: await renderDiagnostics(
        undefined,
        policyStore,
        ctx.agent.getContainmentStatus?.(),
        ctx.agent.getActiveCapabilities?.(),
        ctx.agent.getPolicyWorkspaceId?.(),
        ctx.agent,
      ),
    };
  }

  if (sub === 'autonomous') {
    const requested = parts[1]?.toLowerCase();
    const confirmed = parts.includes('--confirm');
    if (requested !== 'on' && requested !== 'off') {
      return { output: chalk.yellow('Usage: /permissions autonomous on|off') };
    }
    if (requested === 'on' && !confirmed) {
      return {
        output: [
          chalk.bold.red('WARNING — Autonomous mode'),
          'Seepient will execute permitted tools without asking you first.',
          'It may change or delete project files, run commands, or contact services allowed by policy.',
          'OS containment, protected paths, immutable denials, and deployment limits remain enforced.',
          '',
          `To confirm: ${chalk.bold('/permissions autonomous on --confirm')}`,
        ].join('\n'),
      };
    }
    if (!ctx.agent.isPermissionPipelineEnabled?.()) {
      return { output: chalk.red('Autonomous mode requires the protected permission pipeline.') };
    }
    // Review round 9: persisting the setting on a surface that cannot apply
    // it would leave config and runtime diverged — fail before writing.
    if (typeof ctx.agent.setAutonomousMode !== 'function') {
      return { output: chalk.yellow('Autonomous mode is not supported on this surface.') };
    }
    const manager = createSettingsManager();
    const setting = manager.get('permissions.autonomousMode');
    if (setting.origin.startsWith('env:')) {
      return {
        output: chalk.yellow(
          `Autonomous mode is controlled by ${setting.origin.slice(5)}. Unset that environment variable before changing it here.`,
        ),
      };
    }
    const enabled = requested === 'on';
    const previous = ctx.agent.isAutonomousMode?.() ?? false;
    try {
      await manager.setConfirmedAutonomousMode(enabled);
      ctx.agent.setAutonomousMode?.(enabled);
    } catch (error) {
      if (previous !== enabled) {
        await manager.setConfirmedAutonomousMode(previous).catch(() => {});
        ctx.agent.setAutonomousMode?.(previous);
      }
      return { output: chalk.red(`Could not change autonomous mode: ${(error as Error).message}`) };
    }
    return {
      output: enabled
        ? chalk.bold.yellow('Autonomous mode is ON. Seepient will no longer ask for approval within configured safety boundaries.')
        : chalk.green('Autonomous mode is OFF. Seepient will ask before actions that need permission.'),
    };
  }

  if (sub === 'revoke' && ['session', 'project', 'always'].includes(parts[1]?.toLowerCase())) {
    return revokeHumanPermission(
      parts[1].toLowerCase() === 'global' ? 'always' : parts[1].toLowerCase() as 'session' | 'project' | 'always',
      parts[2],
      policyStore,
      ctx.agent.getPolicyWorkspaceId?.(),
      ctx.agent.getWorkspaceRoot?.(),
      ctx.agent.getActiveCapabilities?.() ?? [],
      ctx.agent,
    );
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
    const idx = Number(parts[1]);
    if (!Number.isInteger(idx) || idx < 0) return { output: chalk.red('Usage: /permissions revoke-cap <non-negative-index>') };
    if (typeof ctx.agent.revokePolicyCapability !== 'function') {
      return { output: chalk.yellow('Protected-policy revocation is not supported on this surface.') };
    }
    const workspaceId = ctx.agent.getPolicyWorkspaceId?.();
    if (!workspaceId) return noPolicyStore();
    try {
      const current = await policyStore.read(workspaceId);
      const capability = current.policy.capabilities[idx];
      if (!capability) {
        return { output: chalk.red(`Index ${idx} out of range (0..${current.policy.capabilities.length - 1})`) };
      }
      const snap = await ctx.agent.revokePolicyCapability(capability, current.version);
      return { output: chalk.green(`Revoked capability at index ${idx} → version ${snap?.version ?? "?"}.`) };
    } catch (err) {
      return { output: chalk.red(`Revoke failed: ${(err as Error).message}`) };
    }
  }

  if (sub === 'revoke-global') {
    if (!policyStore) return noPolicyStore();
    const idx = Number(parts[1]);
    if (!Number.isInteger(idx) || idx < 0) return { output: chalk.red('Usage: /permissions revoke-global <non-negative-index>') };
    if (typeof ctx.agent.revokeGlobalPolicyCapability !== 'function') {
      return { output: chalk.yellow('Protected-policy revocation is not supported on this surface.') };
    }
    try {
      const current = await policyStore.read(GLOBAL_WORKSPACE_ID);
      const capability = current.policy.capabilities[idx];
      if (!capability) {
        return { output: chalk.red(`Index ${idx} out of range (0..${current.policy.capabilities.length - 1})`) };
      }
      const snap = await ctx.agent.revokeGlobalPolicyCapability(capability, current.version);
      return { output: chalk.green(`Revoked GLOBAL capability at index ${idx} → version ${snap?.version ?? "?"}.`) };
    } catch (err) {
      return { output: chalk.red(`Revoke failed: ${(err as Error).message}`) };
    }
  }

  if (sub === 'help') {
    return { output: usage() };
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

type IndexedCapability = { capability: Capability; rawIndex: number };

/** Type guard: capabilities whose single dimension is a filesystem root. */
function isRootCapability(c: Capability): c is Capability & { kind: "read-root" | "write-root"; root: string } {
  return c.kind === "read-root" || c.kind === "write-root";
}

/**
 * Structural equality for the session-vs-saved dedup. Mutual covers() is
 * too loose here: a session approval with `argvExact` would be hidden by a
 * stored prefix grant that covers it but permits MORE (review round 9).
 * Only a GLOBAL_WORKSPACE_ROOT read/write root maps onto the concrete
 * workspace root, and only for the SAME kind.
 */
function sameCapability(a: Capability, b: Capability, workspaceRoot?: string): boolean {
  if (
    a.kind === b.kind &&
    workspaceRoot &&
    isRootCapability(a) &&
    isRootCapability(b) &&
    ((a.root === GLOBAL_WORKSPACE_ROOT && b.root === workspaceRoot) ||
      (b.root === GLOBAL_WORKSPACE_ROOT && a.root === workspaceRoot))
  ) {
    return true;
  }
  return capabilityKey(a) === capabilityKey(b);
}

function humanPermission(cap: Capability): string {
  switch (cap.kind) {
    case 'process': {
      const args = cap.argvPrefix ?? [];
      const command = cap.executable === '/bin/sh' && args[0] === '-c' && args[1]
        ? args[1]
        : [cap.executable, ...args].filter(Boolean).join(' ');
      return `Run \`${command || 'a command'}\``;
    }
    case 'commit-file': return `Change \`${cap.path}\``;
    case 'read-file': return `Read \`${cap.path}\``;
    case 'read-root': return `Read files in \`${cap.root === GLOBAL_WORKSPACE_ROOT ? 'the current project' : cap.root}\``;
    case 'write-root': return `Change files in \`${cap.root === GLOBAL_WORKSPACE_ROOT ? 'the current project' : cap.root}\``;
    case 'network-destination': return `Connect to ${cap.host}`;
    case 'external-recipient': return `Send to ${cap.recipient} using ${cap.service}`;
    case 'secret-ref': return `Use the saved credential \`${cap.ref}\``;
    case 'model-egress': return 'Share tool results with the AI provider';
    case 'trusted-host': return 'Use an app-provided tool';
    case 'activate-change-class': return `Activate ${cap.changeClass} changes`;
  }
}

function visiblePermissions(caps: Capability[]): IndexedCapability[] {
  // Every explicit persisted capability stays listed and addressable for
  // revocation — read-root, write-root, and model-egress included (review
  // round 9). Filtering them made them unrevocable through the CLI.
  return caps.map((capability, rawIndex) => ({ capability, rawIndex }));
}

function sessionPermissions(
  active: Capability[],
  project: Capability[],
  global: Capability[],
  workspaceRoot?: string,
): IndexedCapability[] {
  const saved = [...project, ...global];
  // Every session-exclusive authority stays listed and addressable for
  // revocation. Only the pipeline-seeded workspace read baseline (not a
  // session approval) and grants that merely mirror persisted policy are
  // excluded (the latter are revoked under their persisted scope).
  return active
    .map((capability, rawIndex) => ({ capability, rawIndex }))
    .filter(({ capability }) => {
      if (capability.kind === 'read-root' && capability.root === workspaceRoot) return false;
      return !saved.some((stored) => sameCapability(stored, capability, workspaceRoot));
    });
}

function renderScope(
  lines: string[],
  heading: string,
  scope: 'session' | 'project' | 'always',
  permissions: IndexedCapability[],
): void {
  lines.push(chalk.bold(`${heading}:`));
  if (permissions.length === 0) {
    lines.push(chalk.dim('  None'));
  } else {
    permissions.forEach(({ capability }, index) => {
      lines.push(`  ${index + 1}. ${chalk.green(humanPermission(capability))}`);
      lines.push(chalk.dim(`     Remove: /permissions revoke ${scope} ${index + 1}`));
    });
  }
  lines.push('');
}

async function renderPermissions(
  policyStore: PolicyStore | null | undefined,
  active: Capability[] | undefined,
  agentWorkspaceId: string | null | undefined,
  workspaceRoot: string | null | undefined,
  autonomous: boolean,
  agent?: {
    recordRenderedPermissions?: (view: {
      session: string[];
      project: string[];
      global: string[];
    }) => void;
  },
): Promise<string> {
  let projectError: string | undefined;
  let globalError: string | undefined;
  const project = agentWorkspaceId && policyStore
    ? await policyStore.read(agentWorkspaceId).then((s) => s.policy.capabilities).catch((e: unknown) => {
        projectError = e instanceof Error ? e.message : String(e);
        return [];
      })
    : [];
  const global = policyStore
    ? await policyStore.read(GLOBAL_WORKSPACE_ID).then((s) => s.policy.capabilities).catch((e: unknown) => {
        globalError = e instanceof Error ? e.message : String(e);
        return [];
      })
    : [];
  const session = sessionPermissions(active ?? [], project, global, workspaceRoot ?? undefined);
  const consentMode = (agent as any)?.getConsentMode?.() ?? (autonomous ? 'autonomous' : 'edit-enabled');
  const lines = [chalk.bold.cyan('Permissions'), ''];
  lines.push(`${chalk.bold('Consent mode:')} ${chalk.green(consentMode)} (change with ${chalk.bold('/mode')} or Shift+Tab in TUI)`);
  lines.push(
    autonomous
      ? `${chalk.bold.yellow('Autonomous mode: ON')} — Seepient will not ask before permitted actions.`
      : `${chalk.bold('Autonomous mode: OFF')} — Seepient asks before actions that need permission.`,
  );
  lines.push(
    chalk.dim(
      autonomous
        ? 'Turn off: /permissions autonomous off'
        : 'Turn on: /permissions autonomous on',
    ),
    '',
  );
  renderScope(lines, 'This session', 'session', session);
  if (projectError) lines.push(chalk.yellow(`  Could not read project policy: ${projectError}`));
  const visibleProject = visiblePermissions(project);
  renderScope(lines, 'This project', 'project', visibleProject);
  if (globalError) lines.push(chalk.yellow(`  Could not read global policy: ${globalError}`));
  const visibleGlobal = visiblePermissions(global);
  renderScope(lines, 'Every project', 'always', visibleGlobal);
  // Review round 10: the revoke command validates its number against THIS
  // list — record what the operator saw so a later revoke detects drift.
  agent?.recordRenderedPermissions?.({
    session: session.map(({ capability }) => capabilityKey(capability)),
    project: visibleProject.map(({ capability }) => capabilityKey(capability)),
    global: visibleGlobal.map(({ capability }) => capabilityKey(capability)),
  });
  return lines.join('\n').trimEnd();
}

async function revokeHumanPermission(
  scope: 'session' | 'project' | 'always',
  rawNumber: string | undefined,
  policyStore: PolicyStore | null | undefined,
  workspaceId: string | null | undefined,
  workspaceRoot: string | null | undefined,
  active: Capability[],
  agent: {
    revokeSessionCapability?: (capability: Capability) => void;
    revokePolicyCapability?: (capability: Capability, expectedVersion: number) => Promise<unknown>;
    revokeGlobalPolicyCapability?: (capability: Capability, expectedVersion: number) => Promise<unknown>;
    consumeRenderedPermissions?: () => {
      session: string[];
      project: string[];
      global: string[];
    } | null;
  },
): Promise<{ output: string }> {
  const number = Number(rawNumber);
  if (!Number.isInteger(number) || number < 1) {
    return { output: chalk.yellow(`Usage: /permissions revoke ${scope} <number>`) };
  }
  let projectSnap: PolicySnapshot | null = null;
  let globalSnap: PolicySnapshot | null = null;
  try {
    projectSnap = workspaceId && policyStore ? await policyStore.read(workspaceId) : null;
    globalSnap = policyStore ? await policyStore.read(GLOBAL_WORKSPACE_ID) : null;
  } catch (e: unknown) {
    return {
      output: chalk.red(`Could not read policy: ${e instanceof Error ? e.message : String(e)}`),
    };
  }
  const project = projectSnap?.policy.capabilities ?? [];
  const global = globalSnap?.policy.capabilities ?? [];
  const entries = scope === 'session'
    ? sessionPermissions(active, project, global, workspaceRoot ?? undefined)
    : visiblePermissions(scope === 'project' ? project : global);
  // Review round 10: the number addresses the list the operator SAW. A
  // missing or stale rendering rejects the revoke rather than removing a
  // shifted entry — the same posture as the policy-store version guard
  // (review round 9).
  if (agent.consumeRenderedPermissions) {
    const rendered = agent.consumeRenderedPermissions();
    if (rendered === null) {
      return { output: chalk.yellow('Run /permissions first — revoke numbers address the list it shows.') };
    }
    const renderedKeys =
      scope === 'session' ? rendered.session : scope === 'project' ? rendered.project : rendered.global;
    const currentKeys = entries.map(({ capability }) => capabilityKey(capability));
    const unchanged =
      renderedKeys.length === currentKeys.length &&
      renderedKeys.every((key, i) => key === currentKeys[i]);
    if (!unchanged) {
      return { output: chalk.yellow('The permission list changed since it was shown. Run /permissions and try again.') };
    }
  }
  const selected = entries[number - 1];
  if (!selected) {
    return { output: chalk.yellow(`No ${scope} permission numbered ${number}. Run /permissions to see the current list.`) };
  }
  try {
    if (scope === 'session') {
      if (!agent.revokeSessionCapability) {
        return { output: chalk.yellow('Session-capability revocation is not supported on this surface.') };
      }
      agent.revokeSessionCapability(selected.capability);
    } else if (scope === 'project') {
      if (!agent.revokePolicyCapability) {
        return { output: chalk.yellow('Project-policy revocation is not supported on this surface.') };
      }
      // Identity + listed version: a policy that moved between display and
      // removal is rejected rather than removing a shifted entry (review
      // round 9).
      await agent.revokePolicyCapability(selected.capability, projectSnap?.version ?? 0);
    } else {
      if (!agent.revokeGlobalPolicyCapability) {
        return { output: chalk.yellow('Global-policy revocation is not supported on this surface.') };
      }
      await agent.revokeGlobalPolicyCapability(selected.capability, globalSnap?.version ?? 0);
    }
    return { output: chalk.green(`Removed ${scope} permission: ${humanPermission(selected.capability)}`) };
  } catch (error) {
    return { output: chalk.red(`Could not remove permission: ${(error as Error).message}`) };
  }
}

async function renderDiagnostics(
  store: { list(): Array<{ scope: string }> } | null | undefined,
  policyStore: PolicyStore | null | undefined,
  containment: ContainmentPreflightResult | undefined,
  active: Capability[] | undefined,
  agentWorkspaceId: string | null | undefined,
  agent: { getPipelineInitError?: () => string | undefined },
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
        projectSnap.policy.capabilities.forEach((cap, i) => {
          lines.push(`    [${i}] ${chalk.green(describeCapability(cap))}`);
        });
      }
    }
    const globalSnap = await policyStore.read(GLOBAL_WORKSPACE_ID).catch(() => null);
    if (globalSnap && globalSnap.policy.capabilities.length > 0) {
      lines.push(chalk.bold('  Global policy ("Allow always" grants):'));
      globalSnap.policy.capabilities.forEach((cap, i) => {
        lines.push(`    [${i}] ${chalk.green(describeCapability(cap))}`);
      });
      lines.push(chalk.dim('    Revoke: /permissions revoke-global <index>'));
    } else {
      lines.push(chalk.dim('  Global policy: (none)'));
    }
  } else {
    lines.push(chalk.dim('  (not configured — protected policy is opt-in)'));
  }
  const initError = agent.getPipelineInitError?.();
  if (initError) {
    lines.push(chalk.yellow(`  Pipeline init failed: ${initError} — the legacy approval path is active.`));
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
