/**
 * Seepient CLI — /gateway slash command
 *
 * Full management commands for the gateway subsystem.
 * Receives the MCPGateway instance from the REPL when gateway is enabled.
 */

import chalk from 'chalk';

export function createGatewayCommandHandler(gatewayInstance: any): (args: string) => Promise<string> {
  return async (args: string): Promise<string> => {
    if (!gatewayInstance) {
      return chalk.yellow('Gateway is not enabled. Set gateway.enabled=true in settings and restart.');
    }

    const parts = args.trim().split(/\s+/);
    const subcommand = parts[0] ?? 'help';

    switch (subcommand) {
      case 'help':
        return [
          'Gateway management commands:',
          '  /gateway list              - List all targets and their status',
          '  /gateway add <name> <json> - Register a new target (JSON config)',
          '  /gateway remove <name>     - Unregister a target',
          '  /gateway toggle <name>     - Toggle a target on/off',
          '  /gateway routes            - List routing rules',
          '  /gateway routes add <pattern> <target> [priority] - Add route',
          '  /gateway routes remove <pattern> <target> - Remove route',
          '  /gateway credentials       - List credential keys',
          '  /gateway credentials set <key> <value> - Set a credential',
          '  /gateway audit [target] [limit] - View audit logs',
          '  /gateway usage             - Show usage stats',
        ].join('\n');

      case 'list': {
        const targets = gatewayInstance.getTargets();
        const entries = Object.entries(targets);
        if (entries.length === 0) return 'No gateway targets registered.';
        return entries.map(([name, t]: [string, any]) => {
          const status = t.enabled ? chalk.green('enabled') : chalk.red('disabled');
          if (t.kind === 'mcp') {
            const tools = t.capabilities?.tools?.length ?? 0;
            return `  ${name} (${status}, MCP/${t.transport}): ${tools} tools — ${t.description}`;
          }
          return `  ${name} (${status}, REST ${t.baseUrl}): ${t.operations.length} ops — ${t.description}`;
        }).join('\n');
      }

      case 'add': {
        const name = parts[1];
        const jsonStr = parts.slice(2).join(' ');
        if (!name || !jsonStr) return 'Usage: /gateway add <name> <json-config>';
        let target: any;
        try {
          target = JSON.parse(jsonStr);
        } catch {
          return 'Error: Invalid JSON configuration.';
        }
        if (!['mcp', 'rest'].includes(target.kind)) {
          return 'Error: config.kind must be "mcp" or "rest".';
        }
        target.enabled = true;
        try {
          await gatewayInstance.registerTarget(name, target, true);
          return `Target "${name}" registered.`;
        } catch (e: any) {
          return `Error: ${e.message}`;
        }
      }

      case 'remove': {
        const name = parts[1];
        if (!name) return 'Usage: /gateway remove <name>';
        const ok = await gatewayInstance.unregisterTarget(name);
        return ok ? `Target "${name}" removed.` : `Target "${name}" not found.`;
      }

      case 'toggle': {
        const name = parts[1];
        if (!name) return 'Usage: /gateway toggle <name>';
        const targets = gatewayInstance.getTargets();
        const current = targets[name];
        if (!current) return `Target "${name}" not found.`;
        const newState = !current.enabled;
        const ok = await gatewayInstance.toggleTarget(name, newState);
        return ok ? `Target "${name}" ${newState ? 'enabled' : 'disabled'}.` : `Failed to toggle "${name}".`;
      }

      case 'routes': {
        const routesSub = parts[1];
        if (routesSub === 'add') {
          const pattern = parts[2];
          const target = parts[3];
          const priority = parseInt(parts[4] ?? '0', 10);
          if (!pattern || !target) return 'Usage: /gateway routes add <pattern> <target> [priority]';
          await gatewayInstance.addRoute(pattern, target, priority);
          return `Route added: "${pattern}" -> ${target} (priority ${priority}).`;
        }
        if (routesSub === 'remove') {
          const pattern = parts[2];
          const target = parts[3];
          if (!pattern || !target) return 'Usage: /gateway routes remove <pattern> <target>';
          await gatewayInstance.removeRoute(pattern, target);
          return `Route removed: "${pattern}" -> ${target}.`;
        }
        // List routes
        const routes = gatewayInstance.getRoutes();
        if (routes.length === 0) return 'No routing rules configured.';
        return routes.map((r: any) => `  "${r.pattern}" -> ${r.target} (priority ${r.priority})`).join('\n');
      }

      case 'credentials': {
        const credSub = parts[1];
        if (credSub === 'set') {
          const key = parts[2];
          const value = parts.slice(3).join(' ');
          if (!key || !value) return 'Usage: /gateway credentials set <key> <value>';
          await gatewayInstance.setCredential(key, value);
          return `Credential "${key}" set.`;
        }
        // List credential keys
        const keys = gatewayInstance.listCredentialKeys();
        if (keys.length === 0) return 'No credentials stored.';
        return `Stored credential keys:\n  ${keys.join('\n  ')}`;
      }

      case 'audit': {
        const targetFilter = parts[1];
        const limit = parseInt(parts[2] ?? '10', 10);
        const logs = gatewayInstance.getAuditLogs(
          targetFilter && !targetFilter.match(/^\d+$/) ? targetFilter : undefined,
          limit,
        );
        if (logs.length === 0) return 'No audit logs found.';
        return logs.map((l: any) => {
          const ts = new Date(l.timestamp).toISOString();
          const status = l.success ? 'OK' : 'FAIL';
          return `  [${ts}] ${l.agent} -> ${l.target} ${l.operation} (${status}, ${l.durationMs}ms)`;
        }).join('\n');
      }

      case 'usage': {
        const summary = gatewayInstance.getUsageSummary();
        const entries = Object.entries(summary);
        if (entries.length === 0) return 'No gateway usage recorded.';
        return entries.map(([name, stats]: [string, any]) =>
          `  ${name}: ${stats.calls} calls, ${stats.errors} errors`,
        ).join('\n');
      }

      default:
        return `Unknown gateway subcommand: ${subcommand}. Type /gateway help for available commands.`;
    }
  };
}
