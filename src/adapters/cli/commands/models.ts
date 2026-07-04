/**
 * Seepient CLI — /models Command Handler
 *
 * In non-interactive mode, lists configured providers (returns output).
 * In interactive mode, launches the provider/model wizard (owns stdin) — the
 * TUI defers this command.
 */

import chalk from 'chalk';
import { ProviderType } from '../../../providers/types.js';
import { handleModelsCommand } from '../setup.js';
import { isNonInteractive } from '../docker-utils.js';
import { Agent } from '../agent.js';
import type { CommandHandler } from './registry.js';

export function modelsHandler(agent: Agent, config: any, activeProviderType: string): CommandHandler {
  const handler: CommandHandler = async () => {
    if (isNonInteractive()) {
      const configured = Object.keys(config.models || {}).filter(
        (k) => (config.models as any)?.[k]?.apiKey,
      );
      if (configured.length === 0) {
        return { output: chalk.yellow('No providers configured. Set API key env vars to add providers.') };
      }
      const lines = [chalk.bold.cyan('Configured Providers:')];
      for (const p of configured) {
        const model = (config.models as any)?.[p]?.model || 'unknown';
        const marker = p === activeProviderType ? chalk.green(' (active)') : '';
        lines.push(`  ${p} (${model})${marker}`);
      }
      lines.push(chalk.dim('\nUse --provider <name> flag or LLM_PROVIDER env var to switch.'));
      return { output: lines.join('\n') };
    }
    // Interactive wizard — owns stdout/stdin; the TUI defers this command.
    await handleModelsCommand(agent, config, activeProviderType as ProviderType);
    return {};
  };
  return handler;
}
