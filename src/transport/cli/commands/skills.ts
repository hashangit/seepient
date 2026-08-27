/**
 * Seepient CLI — /skills Command Handler
 *
 * Lists loaded skills with descriptions. Returns a structured `render`
 * payload so the TUI renders a dedicated bordered component; the chalk
 * `output` string is the fallback for the readline REPL.
 */

import chalk from 'chalk';
import type { CommandHandler } from './registry.js';
import { titleCaseSkill } from './registry.js';

export const skillsHandler: CommandHandler = async (ctx) => {
  const { agent } = ctx;
  const registry = agent.getSkillRegistry();
  if (!registry || registry.getAll().length === 0) {
    return {
      output: `${chalk.yellow('No skills loaded.')}\n${chalk.dim('Add skills to ~/.agents/skills/, ~/.seepient/skills/, .seepient/skills/, or set SEEPIENT_SKILLS_PATH env var.')}`,
    };
  }

  const skills = registry.getAll().map((s) => ({
    name: s.name,
    description: s.description.split('\n')[0],
  }));

  // Readline fallback (chalk-styled; TUI uses `render` instead).
  const lines = [chalk.bold.cyan('Loaded Skills:')];
  for (const s of skills) {
    lines.push(`${chalk.green(`  ${titleCaseSkill(s.name)}`)}${chalk.dim(` — ${s.description}`)}`);
  }
  lines.push(chalk.dim('\nUse /<skill-name> <query> to invoke a skill directly.'));

  return {
    output: lines.join('\n'),
    render: { component: 'skills', skills },
  };
};
