/**
 * /exit command handler for Seepient CLI.
 *
 * Aliases: /quit
 */

import chalk from 'chalk';
import type { CommandHandler } from './registry.js';

export const exitHandler: CommandHandler = async () => {
  return { exit: true, output: chalk.cyan('Goodbye!') };
};
