/**
 * Seepient CLI — /permissions Command Handler
 *
 * Lists and manages persisted tool-approval grants (session/project/global).
 * Read-only listing works in both the TUI and readline (returns `output`).
 *
 *   /permissions                    — list all grants grouped by scope
 *   /permissions clear <scope>      — remove all grants at a scope
 *                                     (scope: session | project | global)
 *   /permissions revoke <id>        — remove a single grant by id prefix
 *   /permissions help               — usage
 */

import chalk from 'chalk';
import type { GrantScope } from '../../../core/types.js';
import type { CommandHandler } from './registry.js';

const SCOPES: GrantScope[] = ['session', 'project', 'global'];

function usage(): string {
  return [
    chalk.bold.cyan('Usage: /permissions [subcommand]'),
    '',
    `  ${chalk.green('/permissions')}                List all grants grouped by scope`,
    `  ${chalk.green('/permissions clear')} ${chalk.dim('<scope>')}     Remove all grants at a scope (session|project|global)`,
    `  ${chalk.green('/permissions revoke')} ${chalk.dim('<id-prefix>')} Remove a single grant by id (prefix match)`,
    `  ${chalk.green('/permissions help')}           Show this help`,
    '',
    chalk.dim('Grants are created when you approve a tool with a scope beyond "once".'),
    chalk.dim('Session grants are lost on restart; project/global persist on disk.'),
  ].join('\n');
}

export const permissionsHandler: CommandHandler = async (ctx) => {
  const store = ctx.agent.getGrantStore?.();
  if (!store) {
    return { output: chalk.yellow('No grant store available (grants are CLI-only).') };
  }

  const parts = ctx.args.trim().split(/\s+/).filter(Boolean);
  const sub = parts[0]?.toLowerCase();

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

function renderGrants(grants: { id: string; tool: string; pattern?: string; scope: string; createdAt: number }[]): string {
  if (grants.length === 0) {
    return chalk.dim('No permission grants. Approve a tool with a scope beyond "once" to create one.');
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
