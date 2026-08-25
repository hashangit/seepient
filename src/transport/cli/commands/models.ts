import chalk from 'chalk';
import { getDefaultProviderRuntime } from '../../../domain/providers/provider-runtime.js';
import { isNonInteractive } from '../../../foundations/environment.js';
import { Agent } from '../agent.js';
import type { CommandHandler } from './registry.js';

export function modelsHandler(agent: Agent, _config: any, activeProviderType: string): CommandHandler {
  const handler: CommandHandler = async () => {
    const runtime = agent.getProviderRuntime() ?? getDefaultProviderRuntime();
    const effectiveConfig = await runtime.getConfigStore().getEffectiveConfig();
    const providers = Object.entries(effectiveConfig.providers || {});

    if (isNonInteractive()) {
      if (providers.length === 0) {
        return { output: chalk.yellow('No providers configured. Set API key env vars to add providers.') };
      }
      const lines = [chalk.bold.cyan('Configured Providers:')];
      const activeAccount = agent.getProviderAccount() || activeProviderType;
      for (const [id, prov] of providers) {
        const marker = id === activeAccount ? chalk.green(' (active)') : '';
        lines.push(`  ${id} (${(prov as any).upstreamProvider || (prov as any).adapter})${marker}`);
      }
      return { output: lines.join('\n') };
    }
    // Interactive dock — owns stdout/stdin; the TUI defers this command.
    const { runModelManagerStandalone } = await import('../../../ui/tui/overlays/model-manager.js');
    await runModelManagerStandalone({
      activeAccount: agent.getProviderAccount() || activeProviderType,
      activeModel: agent.getModel(),
      onSwitchProvider: (account: string, model?: string) => agent.switchProvider(account, model),
    });
    return {};
  };
  return handler;
}

