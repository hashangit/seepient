/**
 * Build the shared slash-command registry.
 *
 * Single owner of which commands exist and how they're wired — used by both
 * the readline REPL (`repl.ts`) and the Ink TUI (`tui/`). Handlers follow one
 * contract: they return `{ output, exit }` and never write to stdout directly.
 *
 * `interactive: true` marks handlers that own stdin/stdout (inquirer wizards,
 * ora spinners, the setup wizard). They run in the readline REPL but the TUI
 * defers them (Ink owns stdin there).
 */

import type { Agent } from '../agent.js';
import { CommandRegistry } from './registry.js';
import { createHelpHandler } from './help.js';
import { clearHandler } from './clear.js';
import { exitHandler } from './exit.js';
import { compactHandler } from './compact.js';
import { skillsHandler } from './skills.js';
import { contextHandler } from './context.js';
import { modelsHandler } from './models.js';
import { settingsHandler } from './settings.js';
import { permissionsHandler } from './permissions.js';
import { runSetup } from '../setup.js';

export function buildCommandRegistry(
  agent: Agent,
  config: any,
  activeProviderType: string,
  gatewayInstance?: any,
): CommandRegistry {
  const registry = new CommandRegistry();
  const skillRegistry = agent.getSkillRegistry();

  // Tier 1 — Session Control
  registry.register('help', createHelpHandler(registry, skillRegistry), {
    description: 'Show available commands',
    aliases: ['?'],
  });
  registry.register('clear', clearHandler, {
    description: 'Clear conversation history',
    aliases: ['reset', 'new'],
  });
  registry.register('exit', exitHandler, {
    description: 'End the session',
    aliases: ['quit'],
  });
  registry.register('compact', compactHandler, {
    description: 'Compress conversation to a summary',
    aliases: ['compress'],
    interactive: true, // ora spinner
  });

  // Tier 2 — Configuration & Discovery
  registry.register('skills', skillsHandler, {
    description: 'List loaded skills',
  });
  registry.register('context', contextHandler, {
    description: 'Show context-window breakdown (tokens by component)',
    aliases: ['ctx'],
  });
  registry.register('models', modelsHandler(agent, config, activeProviderType), {
    description: 'Switch providers and models',
    aliases: ['model'],
    interactive: true, // inquirer wizard
  });
  registry.register('sessions', async () => ({
    output: 'Session selector is available in the TUI: run /sessions or Ctrl+P → sessions.',
  }), {
    description: 'Resume, switch, or delete a session',
    aliases: ['session'],
    interactive: true, // TUI overlay (intercepted by handleUserInput before dispatch)
  });
  registry.register('steer', async () => ({
    output: '/steer <message> interrupts the current run and sends a new message. Available in the TUI.',
  }), {
    description: 'Interrupt the run and send a new message',
    interactive: true, // TUI-intercepted (works during a run — its purpose)
  });
  registry.register('settings', settingsHandler(), {
    description: 'View and edit configuration',
    aliases: ['config', 'setting'],
    // Not flagged interactive: read subcommands (list/get/reset/export/help)
    // return output and work in the TUI. The wizard (no args) + `set` use
    // inquirer and are intercepted by the TUI's handleUserInput.
  });
  registry.register('permissions', permissionsHandler, {
    description: 'List and revoke tool-approval grants',
    aliases: ['perms'],
  });
  registry.register('setup', async () => {
    await runSetup();
    return {};
  }, {
    description: 'Run the setup wizard',
    interactive: true,
  });

  // Gateway management — handler returns a string; adapt to CommandResult.
  registry.register('gateway', async (ctx) => {
    const { createGatewayCommandHandler } = await import('./gateway.js');
    const handler = createGatewayCommandHandler(gatewayInstance);
    return { output: await handler(ctx.args) };
  }, {
    description: 'Gateway management (targets, routes, credentials)',
    aliases: ['gw'],
  });

  return registry;
}
