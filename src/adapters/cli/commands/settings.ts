/**
 * Seepient CLI — /settings Command Handler
 *
 * Read subcommands (list/get/reset/export/help) return their output for the
 * adapter to render. The interactive wizard and `set` use inquirer (own stdin)
 * and self-print — the TUI defers those. Subcommand router accepts direct ops.
 */

import chalk from 'chalk';
import inquirer from 'inquirer';
import { SettingsManager } from '../../../core/settings-manager.js';
import { SettingsError } from '../../../core/settings-manager.js';
import {
  SETTINGS_MAP,
  SETTINGS_SCHEMA,
  SETTINGS_CATEGORIES,
  isSecretField,
  isRestartRequired,
  getSettingsByCategory,
} from '../../../core/settings-schema.js';
import {
  formatSettingValue,
  formatSettingTable,
  SettingRow,
  renderWizardHeader,
  renderSettingsList,
  renderSettingForm,
  renderCategoryStatus,
} from './settings-utils.js';
import { loadMergedConfig, loadJsonConfig, getConfigPaths, applyEnvOverrides } from '../config-loader.js';
import { isNonInteractive } from '../docker-utils.js';
import type { CommandHandler, CommandContext } from './registry.js';

// ── Subcommand router ─────────────────────────────────────────────────────

type Subcommand = 'list' | 'get' | 'set' | 'reset' | 'export' | 'help';

function parseSubcommand(args: string): { sub: Subcommand | null; rest: string } {
  const parts = args.trim().split(/\s+/);
  const first = parts[0]?.toLowerCase();
  const subcommands: Subcommand[] = ['list', 'get', 'set', 'reset', 'export', 'help'];

  if (!first) return { sub: null, rest: '' };
  if (subcommands.includes(first as Subcommand)) {
    return { sub: first as Subcommand, rest: parts.slice(1).join(' ') };
  }
  return { sub: null, rest: args };
}

// ── Manager factory ───────────────────────────────────────────────────────

function createManager(): SettingsManager {
  const config = applyEnvOverrides(loadMergedConfig());
  const paths = getConfigPaths();
  const projectConfig = loadJsonConfig(paths.local);
  const globalConfig = loadJsonConfig(paths.global);

  return new SettingsManager({
    config,
    projectConfigPath: paths.local,
    globalConfigPath: paths.global,
    projectConfig: projectConfig as Record<string, any>,
    globalConfig: globalConfig as Record<string, any>,
  });
}

// ── Main handler ──────────────────────────────────────────────────────────

export function settingsHandler(): CommandHandler {
  return async (ctx: CommandContext) => {
    const { sub, rest } = parseSubcommand(ctx.args);
    const manager = createManager();

    if (sub === 'list' || (sub === null && isNonInteractive())) {
      return { output: handleList(manager) };
    }
    if (sub === 'get') return { output: handleGet(manager, rest) };
    if (sub === 'set') {
      await handleSet(manager, rest);
      return {};
    }
    if (sub === 'reset') return { output: await handleReset(manager, rest) };
    if (sub === 'export') return { output: handleExport(manager) };
    if (sub === 'help') return { output: handleHelp() };
    // sub === null && interactive → wizard (owns stdin)
    await handleWizard(manager);
    return {};
  };
}

// ── Level 1: Category Menu (interactive — self-prints) ────────────────────

async function handleWizard(manager: SettingsManager): Promise<void> {
  while (true) {
    console.log(renderWizardHeader(manager));

    const choices = SETTINGS_CATEGORIES.map(c => {
      const status = renderCategoryStatus(c.key, manager);
      const keys = getSettingsByCategory(c.key);
      const suffix = keys.length > 0 ? `(${keys.length})` : '';
      return { name: `${c.label}  ${status}  ${suffix}`, value: c.key };
    });

    let selected: string;
    try {
      const result = await inquirer.prompt([{
        type: 'list',
        name: 'selected',
        message: 'Select a category:',
        choices: [
          ...choices,
          new inquirer.Separator(),
          { name: 'View full config (JSON)', value: '__export' },
          { name: 'Reset to defaults', value: '__reset' },
          { name: 'Done', value: '__done' },
        ],
      }]);
      selected = result.selected;
    } catch {
      return; // Ctrl+C
    }

    if (selected === '__done') return;
    if (selected === '__export') {
      console.log(handleExport(manager));
      return;
    }
    if (selected === '__reset') {
      try {
        const { confirm } = await inquirer.prompt([{
          type: 'confirm',
          name: 'confirm',
          message: 'Reset all settings to defaults?',
          default: false,
        }]);
        if (confirm) {
          await manager.resetAll();
          console.log(chalk.green('All settings reset to defaults.'));
        }
      } catch {
        return; // Ctrl+C
      }
      continue;
    }

    await handleCategoryDrilldown(manager, selected);
  }
}

// ── Level 2: Settings List (interactive — self-prints) ────────────────────

async function handleCategoryDrilldown(manager: SettingsManager, category: string): Promise<void> {
  const catEntry = SETTINGS_CATEGORIES.find(c => c.key === category);
  if (!catEntry) return;
  const keys = getSettingsByCategory(catEntry.key);
  const categoryInfo = catEntry;

  while (true) {
    console.log('');
    console.log(chalk.bold(`  ${categoryInfo.label}`));
    console.log('');
    console.log(renderSettingsList(keys, manager));
    console.log('');

    const settingChoices = keys.map(k => {
      const entry = SETTINGS_MAP.get(k);
      const result = manager.get(k);
      const label = entry?.label ?? k;
      const value = formatSettingValue(result.value, result.masked);
      return { name: `${label}: ${value}`, value: k };
    });

    let selected: string;
    try {
      const result = await inquirer.prompt([{
        type: 'list',
        name: 'selected',
        message: 'Select a setting to edit:',
        choices: [
          ...settingChoices,
          new inquirer.Separator(),
          { name: '← Back to categories', value: '__back' },
        ],
      }]);
      selected = result.selected;
    } catch {
      return; // Ctrl+C
    }

    if (selected === '__back') return;
    await handleSettingEdit(manager, selected);
  }
}

// ── Level 3: Bordered Mini-Form (interactive — self-prints) ───────────────

async function handleSettingEdit(manager: SettingsManager, dotKey: string): Promise<void> {
  const entry = SETTINGS_MAP.get(dotKey);
  const schema = SETTINGS_SCHEMA.get(dotKey);
  const label = entry?.label ?? dotKey;

  while (true) {
    console.log('');
    console.log(renderSettingForm(dotKey, manager));
    console.log('');

    // Warn if env var overrides this setting
    const envVar = schema?.envVar;
    if (envVar && process.env[envVar]) {
      console.log(chalk.yellow(`  ⚠ This setting is overridden by env var ${envVar}`));
      console.log(chalk.yellow(`    Your edit will only take effect when ${envVar} is unset.`));
      console.log('');
    }

    // Determine prompt type from schema
    let promptType: string;
    let promptChoices: { name: string; value: string }[] | undefined;
    let validate: ((input: string) => boolean | string) | undefined;

    if (schema?.type === 'boolean') {
      promptType = 'confirm';
    } else if (schema?.type === 'enum' && schema.enumValues) {
      promptType = 'list';
      promptChoices = schema.enumValues.map(v => ({ name: v, value: v }));
    } else if (schema?.secret) {
      promptType = 'password';
    } else {
      promptType = 'input';
      // M4: Validate number fields
      if (schema?.type === 'number') {
        validate = (input: string) => {
          const num = Number(input);
          if (isNaN(num)) return 'Please enter a valid number';
          if (schema.min !== undefined && num < schema.min) return `Minimum value is ${schema.min}`;
          if (schema.max !== undefined && num > schema.max) return `Maximum value is ${schema.max}`;
          return true;
        };
      }
    }

    const current = manager.get(dotKey);
    const promptConfig: any = {
      type: promptType,
      name: 'newValue',
      message: `New value for ${label}:`,
    };
    if (promptType === 'password') promptConfig.mask = '*';
    if (promptType === 'input' && current.value != null && !schema?.secret) {
      promptConfig.default = String(current.value);
    }
    if (validate) promptConfig.validate = validate;
    if (promptType === 'confirm' && current.value != null) {
      promptConfig.default = Boolean(current.value);
    }
    if (promptType === 'list' && promptChoices) {
      promptConfig.choices = promptChoices;
      if (current.value != null) promptConfig.default = String(current.value);
    }

    let newValue: any;
    try {
      const result = await inquirer.prompt([promptConfig]);
      newValue = result.newValue;
    } catch {
      return; // Ctrl+C
    }

    // Boolean confirm — value is already boolean, set directly
    if (promptType === 'confirm') {
      try {
        await manager.set(dotKey, String(newValue));
        const updated = manager.get(dotKey);
        console.log(chalk.green(`  Updated ${dotKey} = ${formatSettingValue(updated.value, updated.masked)}`));
      } catch (e: any) {
        console.log(chalk.red(`  Error: ${e.message}`));
      }
      return;
    }

    // For other types, empty means cancel
    if (!newValue && newValue !== 0) {
      console.log(chalk.dim('  Cancelled.'));
      return;
    }

    try {
      await manager.set(dotKey, String(newValue));
      const updated = manager.get(dotKey);
      console.log(chalk.green(`  Updated ${dotKey} = ${formatSettingValue(updated.value, updated.masked)}`));
      if (isRestartRequired(dotKey)) {
        console.log(chalk.yellow('  Restart the REPL for this change to take full effect.'));
      }
      return;
    } catch (e: any) {
      console.log(chalk.red(`  Error: ${e.message}`));
      console.log(chalk.dim('  Retrying...'));
      // Loop to retry
    }
  }
}

// ── Read subcommands (return output for the adapter to render) ────────────

function handleList(manager: SettingsManager): string {
  const settings = manager.list();
  const rows: SettingRow[] = settings.map(s => ({
    dotKey: s.dotKey,
    value: formatSettingValue(s.value, s.masked),
    origin: s.origin,
    category: s.category,
    restartRequired: s.restartRequired,
  }));
  return formatSettingTable(rows);
}

function handleGet(manager: SettingsManager, args: string): string {
  const dotKey = args.trim();
  if (!dotKey) {
    return chalk.yellow('Usage: /settings get <dot.key>');
  }

  try {
    const result = manager.get(dotKey);
    const schema = SETTINGS_SCHEMA.get(dotKey);
    const lines = [`${chalk.cyan(dotKey)} = ${formatSettingValue(result.value, result.masked)}`];
    if (schema?.default !== undefined && result.value !== schema.default) {
      lines.push(chalk.dim(`  Default: ${schema.default}`));
    }
    lines.push(chalk.dim(`  Source: ${result.origin}`));
    if (isRestartRequired(dotKey)) {
      lines.push(chalk.yellow('  [restart required]'));
    }
    return lines.join('\n');
  } catch (e: any) {
    return chalk.red(e.message);
  }
}

async function handleSet(manager: SettingsManager, args: string): Promise<void> {
  const parts = args.trim().split(/\s+/);
  const dotKey = parts[0];
  let value = parts.slice(1).join(' ');

  if (!dotKey) {
    console.log(chalk.yellow('Usage: /settings set <dot.key> <value>'));
    return;
  }

  // Secret field with no value — prompt
  if (!value && isSecretField(dotKey)) {
    const answers = await inquirer.prompt([{
      type: 'password',
      name: 'secretValue',
      message: `Enter new value for ${dotKey}:`,
      mask: '*',
    }]);
    value = answers.secretValue;
    if (!value) return;
  } else if (!value || value === '-') {
    const answers = await inquirer.prompt([{
      type: 'password',
      name: 'secretValue',
      message: `Enter new value for ${dotKey}:`,
      mask: '*',
    }]);
    value = answers.secretValue;
    if (!value) return;
  }

  try {
    await manager.set(dotKey, value);
    const result = manager.get(dotKey);
    console.log(chalk.green(`Updated ${dotKey} = ${formatSettingValue(result.value, result.masked)}`));
    if (isRestartRequired(dotKey)) {
      console.log(chalk.yellow('Restart the REPL for this change to take full effect.'));
    } else {
      console.log(chalk.dim('Change takes effect immediately.'));
    }
  } catch (e: any) {
    if (e instanceof SettingsError) {
      console.log(chalk.red(`Error: ${e.message}`));
    } else {
      console.log(chalk.red(`Error: ${e.message}`));
    }
  }
}

async function handleReset(manager: SettingsManager, args: string): Promise<string> {
  const dotKey = args.trim();
  if (!dotKey) {
    return chalk.yellow('Usage: /settings reset <dot.key>');
  }

  try {
    await manager.reset(dotKey);
    return chalk.green(`Reset ${dotKey} to default.`);
  } catch (e: any) {
    return chalk.red(`Error: ${e.message}`);
  }
}

function handleExport(manager: SettingsManager): string {
  const settings = manager.list();
  const obj: Record<string, any> = {};
  for (const s of settings) {
    obj[s.dotKey] = formatSettingValue(s.value, s.masked);
  }
  return JSON.stringify(obj, null, 2);
}

function handleHelp(): string {
  const lines = [
    `${chalk.bold.cyan('/settings')} — View and edit configuration`,
    '',
    'Usage:',
    '  /settings                          Interactive settings wizard',
    '  /settings list [category]          List settings in a category',
    '  /settings get <dot.key>            Show current value + origin',
    '  /settings set <dot.key> <value>    Set a value',
    '  /settings reset <dot.key>          Remove a value (revert to default)',
    '  /settings export                   Print full merged config as JSON',
    '  /settings help                     Show this help',
    '',
    chalk.dim('Aliases: /config, /setting'),
    chalk.dim('Setup wizard: /setup'),
  ];
  return lines.join('\n');
}
