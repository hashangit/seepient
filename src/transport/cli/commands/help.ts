/**
 * `/help` slash command handler.
 *
 * Displays available commands and loaded skills.
 * Use `--all` to include hidden commands and aliases.
 */

import type { CommandHandler, CommandRegistry } from './registry.js';
import type { SkillRegistry } from '../../../capabilities/skills/types.js';

export function createHelpHandler(
  registry: CommandRegistry,
  skillRegistry?: SkillRegistry | null,
): CommandHandler {
  return async (ctx) => {
    const showAll = ctx.args.trim() === '--all';
    return { output: registry.help(showAll, skillRegistry ?? ctx.agent.getSkillRegistry()) };
  };
}
