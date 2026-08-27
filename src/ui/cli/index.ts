#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { isNonInteractive } from '../../foundations/environment.js';
import { runSetup } from '../../transport/cli/setup.js';
import { runChat } from '../repl/repl.js';
import { resolveLaunchMode } from '../../domain/prompts/system-prompts.js';

// Handle Ctrl+C gracefully
function handleExit() {
  console.log(chalk.cyan("\n\nGoodbye! (Interrupted)"));
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  process.stdin.pause();
  process.exit(0);
}

process.on('SIGINT', handleExit);
process.on('SIGTERM', handleExit);

// Load local env vars (lowest priority of env vars, but env vars override JSON)
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgPath = path.join(__dirname, '..', '..', '..', 'package.json');
let version = '0.5.4';

try {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  version = pkg.version;
} catch (e) {
  // Fallback if package.json not found in expected location
}

const program = new Command();

program
  .name('seepient')
  .description('A lightweight AI agent CLI tool')
  .version(version)
  .option('-m, --model <model>', 'Model to use')
  .option('-p, --provider <provider>', 'Provider to use (openai-compatible|openai|anthropic|glm)')
  .option('-n, --no-interactive', 'Exit after processing the initial query (Headless mode)')
  .option('--docker', 'Docker mode: implies --no-interactive, disables all prompts, uses env vars and config only')
  .option('-y, --yes', 'Autonomous mode: auto-approve actions within deployment ceiling (alias for --mode autonomous)')
  .option('--mode <mode>', 'Consent mode: ask-everything | edit-enabled (default) | autonomous')
  .option('-r, --resume <id>', 'Resume a previous session by id (or "last")');

program
  .command('setup')
  .description('Run the interactive setup wizard to configure API keys')
  .option('-p, --project', 'Save configuration to project-level (.seepient/setting.json)')
  .action(async (options) => {
    // Setup wizard cannot run in non-interactive mode
    if (isNonInteractive()) {
      console.log(chalk.yellow('Setup wizard requires an interactive terminal.'));
      console.log(chalk.dim('Set API keys via environment variables instead:'));
      console.log(chalk.dim('  OPENAI_API_KEY, ANTHROPIC_API_KEY, GLM_API_KEY'));
      console.log(chalk.dim('  LLM_PROVIDER (openai-compatible|openai|anthropic|glm)'));
      console.log(chalk.dim('Or mount a config file at ~/.seepient/setting.json'));
      process.exit(1);
    }
    await runSetup(options);
  });

import { registerAuthCommands } from '../../transport/cli/commands/auth-cli.js';
import { registerProvidersCommands } from '../../transport/cli/commands/providers-cli.js';
import { registerModelsCommands } from '../../transport/cli/commands/models-cli.js';

registerAuthCommands(program);
registerProvidersCommands(program);
registerModelsCommands(program);

program
  .command('chat [query...]', { isDefault: true })
  .description('Start the AI agent (default)')
  .action(async (queryParts) => {
    const options = program.opts();
    // Dispatch on the SAME predicate that selects the system prompt, so launch
    // mode and UI mode can never diverge (FR-001). The TUI is lazy-imported
    // only in interactive mode; headless / piped / --docker never load React.
    if (resolveLaunchMode(options) === 'interactive') {
      const { startTui } = await import('../tui/index.js');
      await startTui({ queryParts, options });
    } else {
      await runChat(queryParts, options);
    }
  });

// Apply --docker flag effects early from raw argv (before Commander parses)
// This ensures isNonInteractive() works correctly during the parse phase
if (process.argv.includes('--docker')) {
  process.env.SEEPIENT_DOCKER = 'true';
  process.env.SEEPIENT_NO_INTERACTIVE = 'true';
}

// Global error containment for async CLI execution
process.on("unhandledRejection", (reason: any) => {
  const msg = reason?.message || String(reason);
  console.error(chalk.red(`Error: ${msg}`));
  process.exit(1);
});

try {
  await program.parseAsync(process.argv);
} catch (err: any) {
  if (err?.code !== "commander.helpDisplayed" && err?.code !== "commander.version" && err?.exitCode !== 0) {
    console.error(chalk.red(`Error: ${err?.message || String(err)}`));
    process.exit(1);
  }
}
