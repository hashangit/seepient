#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { isNonInteractive } from './docker-utils.js';
import { runSetup } from './setup.js';
import { runChat } from './repl.js';
import { resolveLaunchMode } from './system-prompts.js';

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
let version = '0.2.2';

try {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  version = pkg.version;
} catch (e) {
  // Fallback if package.json not found in expected location
}

const program = new Command();

/** Commander collect fn: accumulate repeated --option values into an array. */
function collectRepeated(value: string, acc: string[]): string[] {
  acc.push(value);
  return acc;
}

program
  .name('seepient')
  .description('A lightweight AI agent CLI tool')
  .version(version)
  .option('-m, --model <model>', 'Model to use')
  .option('-p, --provider <provider>', 'Provider to use (openai-compatible|openai|anthropic|glm)')
  .option('-n, --no-interactive', 'Exit after processing the initial query (Headless mode)')
  .option('--docker', 'Docker mode: implies --no-interactive, disables all prompts, uses env vars and config only')
  .option('-y, --yes', 'Auto-confirm all tool executions (e.g., shell commands)')
  .option('--headless', 'Bypass permission matrix: auto-approve all tools (for CI/Docker/scripts)')
  .option('--strict', 'Permission level: auto-approve safe tools only')
  .option('--moderate', 'Permission level: auto-approve safe + edit + communications (default)')
  .option('--yolo', 'Permission level: auto-approve all tools')
  .option('--allow-once <spec>', 'Pre-grant a tool for this run only (repeatable): "tool" or "tool:pattern"', collectRepeated, [])
  .option('--allow-session <spec>', 'Pre-grant a tool for this session (repeatable): "tool" or "tool:pattern"', collectRepeated, [])
  .option('--allow-project <spec>', 'Pre-grant a tool for this project, persisted (repeatable): "tool" or "tool:pattern"', collectRepeated, [])
  .option('--allow-global <spec>', 'Pre-grant a tool globally, persisted (repeatable): "tool" or "tool:pattern"', collectRepeated, [])
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

program
  .command('chat [query...]', { isDefault: true })
  .description('Start the AI agent (default)')
  .action(async (queryParts) => {
    const options = program.opts();
    // Dispatch on the SAME predicate that selects the system prompt, so launch
    // mode and UI mode can never diverge (FR-001). The TUI is lazy-imported
    // only in interactive mode; headless / piped / --docker never load React.
    if (resolveLaunchMode(options) === 'interactive') {
      const { startTui } = await import('./tui/index.js');
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

program.parse(process.argv);
