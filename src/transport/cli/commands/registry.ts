/**
 * Slash Command Registry for Seepient CLI.
 *
 * Flat namespace of `/command` handlers with alias support.
 *
 * Consistent contract: every handler returns a `CommandResult` describing what
 * to render (`output`) and whether to terminate (`exit`). Handlers never write
 * to stdout directly — the adapter renders the result (readline prints it; the
 * TUI appends it to the feed). Lookup order: exact match → alias → skill
 * invocation → unknown.
 *
 * `interactive` marks handlers that take over stdin/stdout themselves (inquirer
 * wizards, ora spinners). They keep working in the readline REPL but cannot run
 * under the TUI's stdin ownership — the TUI defers them.
 */

import chalk from 'chalk';
import type { Agent } from '../agent.js';
import type { SkillRegistry } from '../../../capabilities/skills/types.js';
import type { ContextBreakdown } from '../../../foundations/contracts/context.js';

// ── Types ──────────────────────────────────────────────────────────────

export interface CommandContext {
  agent: Agent;
  args: string;
  config: any;
}

/**
 * A structured render payload — a handler can return this instead of (or
 * alongside) `output` so the TUI renders a purpose-built component rather than
 * a chalk string that gets ANSI-stripped. The readline REPL ignores this and
 * falls back to `output`.
 */
export type CommandRender =
  | {
      component: 'skills';
      skills: Array<{ name: string; description: string }>;
    }
  | {
      component: 'context';
      breakdown: ContextBreakdown;
    };

/**
 * A handler's outcome. `output` is the text the adapter renders (undefined if
 * the handler produced none). `exit` signals the session should terminate.
 * `render` carries structured data the TUI renders as a dedicated component.
 */
export interface CommandResult {
  output?: string;
  exit?: boolean;
  render?: CommandRender;
}

export type CommandHandler = (ctx: CommandContext) => Promise<CommandResult>;

/**
 * Display form of a kebab-case skill name: capitalize the first letter of each
 * segment (e.g. `debug-mantra` → `Debug-mantra`). The invocation name (passed
 * to `/<skill-name>`) stays lowercase — this is a display-only transform.
 */
export function titleCaseSkill(name: string): string {
  return name
    .split('-')
    .map((seg) => (seg.length === 0 ? seg : seg[0].toUpperCase() + seg.slice(1)))
    .join('-');
}

export interface CommandEntry {
  name: string;
  handler: CommandHandler;
  description: string;
  aliases: string[];
  hidden?: boolean; // hidden from /help unless --all
  /** Handler owns stdin/stdout (inquirer/ora) — TUI-deferred, readline-only. */
  interactive?: boolean;
}

export type DispatchStatus = 'handled' | 'fallthrough' | 'exit';

export interface DispatchResult {
  status: DispatchStatus;
  output?: string;
  render?: CommandRender;
}

// ── Registry ───────────────────────────────────────────────────────────

export class CommandRegistry {
  private commands = new Map<string, CommandEntry>();
  private aliasMap = new Map<string, string>(); // alias → canonical name

  register(
    name: string,
    handler: CommandHandler,
    options: { description: string; aliases?: string[]; hidden?: boolean; interactive?: boolean },
  ): void {
    const entry: CommandEntry = {
      name,
      handler,
      description: options.description,
      aliases: options.aliases ?? [],
      hidden: options.hidden,
      interactive: options.interactive,
    };
    this.commands.set(name, entry);
    for (const alias of entry.aliases) {
      this.aliasMap.set(alias, name);
    }
  }

  /** Resolve a raw input string to its command entry (exact or alias), or null. */
  resolveCommand(input: string): CommandEntry | null {
    const trimmed = input.trim();
    if (!trimmed.startsWith('/')) return null;
    const withoutSlash = trimmed.slice(1);
    const spaceIdx = withoutSlash.indexOf(' ');
    const cmdName = (spaceIdx === -1 ? withoutSlash : withoutSlash.slice(0, spaceIdx)).toLowerCase();
    return this.commands.get(cmdName) ?? this.commands.get(this.aliasMap.get(cmdName) ?? '') ?? null;
  }

  /**
   * Dispatch a raw user input string. Handlers return their output; the caller
   * renders it. Returns `fallthrough` for non-commands and unmatched skills.
   */
  async dispatch(
    input: string,
    ctx: CommandContext,
    skillRegistry: SkillRegistry | null,
  ): Promise<DispatchResult> {
    const entry = this.resolveCommand(input);
    if (entry) {
      const withoutSlash = input.trim().slice(1);
      const spaceIdx = withoutSlash.indexOf(' ');
      const args = spaceIdx === -1 ? '' : withoutSlash.slice(spaceIdx + 1);
      const result = await entry.handler({ ...ctx, args });
      return { status: result.exit ? 'exit' : 'handled', output: result.output, render: result.render };
    }

    // Skill invocation — delegate to caller (skill name with no matching command)
    const trimmed = input.trim();
    if (trimmed.startsWith('/')) {
      const cmdName = trimmed.slice(1).split(/\s+/)[0]?.toLowerCase() ?? '';
      if (skillRegistry && cmdName.length > 1) {
        return { status: 'fallthrough' };
      }
    }

    // Unknown command
    const unknownName = trimmed.slice(1).split(/\s+/)[0] ?? '';
    return {
      status: 'handled',
      output: `${chalk.yellow(`Unknown command: ${unknownName}`)}\n${chalk.dim('Type /help for available commands.')}`,
    };
  }

  /**
   * Generate help text.
   * @param showAll If true, include hidden commands and aliases.
   * @param skillRegistry If provided, list loaded skills.
   */
  help(showAll?: boolean, skillRegistry?: SkillRegistry | null): string {
    const lines: string[] = [];
    lines.push(chalk.bold.cyan('Available Commands:'));
    lines.push('');

    for (const entry of this.commands.values()) {
      if (entry.hidden && !showAll) continue;
      const aliasStr =
        entry.aliases.length > 0
          ? chalk.dim(` (${entry.aliases.join(', ')})`)
          : '';
      lines.push(`  ${chalk.green(`/${entry.name}`)}${aliasStr}  — ${entry.description}`);
    }

    if (skillRegistry && skillRegistry.getAll().length > 0) {
      lines.push('');
      lines.push(chalk.bold.cyan('Loaded Skills:'));
      lines.push(chalk.dim('  Use /<skill-name> [args] to invoke'));
      for (const s of skillRegistry.getAll()) {
        const desc = s.description.split('\n')[0];
        lines.push(`  ${chalk.green(`/${titleCaseSkill(s.name)}`)}  — ${desc}`);
      }
    }

    if (!showAll) {
      lines.push('');
      lines.push(chalk.dim('Use /help --all to see aliases and hidden commands.'));
    }

    lines.push('');
    lines.push(chalk.dim('Prefixes: @path (file injection)  !shell (shell passthrough)'));

    return lines.join('\n');
  }

  /** Get all registered command entries. */
  getAll(): CommandEntry[] {
    return [...this.commands.values()];
  }
}
