/**
 * Seepient CLI — /skills Command Handler
 *
 * Lists loaded skills with descriptions.
 */

import chalk from 'chalk';
import type { CommandHandler } from './registry.js';

export const skillsHandler: CommandHandler = async (ctx) => {
  const { agent } = ctx;
  const registry = agent.getSkillRegistry();
  if (!registry || registry.getAll().length === 0) {
    return {
      output: `${chalk.yellow('No skills loaded.')}\n${chalk.dim('Add skills to .seepient/skills/ or set SEEPIENT_SKILLS_PATH env var.')}`,
    };
  }
  const lines = [chalk.bold.cyan('Loaded Skills:')];
  for (const s of registry.getAll()) {
    lines.push(`${chalk.green(`  ${s.name}`)}${chalk.dim(` — ${s.description.split('\n')[0]}`)}`);
  }
  lines.push(chalk.dim('\nUse /<skill-name> <query> to invoke a skill directly.'));
  return { output: lines.join('\n') };
};
