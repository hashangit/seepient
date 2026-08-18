/**
 * Seepient CLI — Setup Wizard
 *
 * Interactive setup wizard for configuring API keys and providers.
 * Extracted from index.ts for separation of concerns.
 */

import inquirer from 'inquirer';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ProviderType } from '../../foundations/contracts/llm.js';
import { MODEL_CATALOG, CUSTOM_MODEL_VALUE, DEFAULT_MODELS } from '../../foundations/models-catalog.js';
import { createProviderFromApp } from '../../domain/providers/provider-resolver.js';
import { Agent } from './agent.js';
import {
  type AppConfig,
  getConfigPath,
  getConfigDir,
  getConfigPaths,
  loadJsonConfig,
  loadMergedConfig,
  maskSecret,
  saveConfig,
  writeConfigToPath,
} from './config-loader.js';
import { isNonInteractive } from '../../foundations/environment.js';

// ── Constants ──────────────────────────────────────────────────────────

const ALL_PROVIDER_TYPES: ProviderType[] = ['openai-compatible', 'openai', 'anthropic', 'glm'];
const ADD_PROVIDER_VALUE = '__add_provider__';
type ProviderAction = 'switch' | 'edit' | 'remove' | 'back';

// ── Setup Wizard ───────────────────────────────────────────────────────

/**
 * Run the interactive setup wizard.
 * @param options.project - If true, save to project-level config instead of global.
 */
export async function runSetup(options: any = {}): Promise<void> {
  // Guard: setup wizard requires interactive TTY
  if (isNonInteractive()) {
    console.log(chalk.yellow('Setup wizard requires an interactive terminal.'));
    console.log(chalk.dim('Set API keys via environment variables instead:'));
    console.log(chalk.dim('  OPENAI_API_KEY, ANTHROPIC_API_KEY, GLM_API_KEY'));
    console.log(chalk.dim('  LLM_PROVIDER (openai-compatible|openai|anthropic|glm)'));
    console.log(chalk.dim('Or mount a config file at ~/.seepient/setting.json'));
    process.exit(1);
  }

  const isProject = options.project;
  const { global: GLOBAL_CONFIG_FILE, local: LOCAL_CONFIG_FILE, globalDir: GLOBAL_CONFIG_DIR } = getConfigPaths();
  const targetFile = isProject ? LOCAL_CONFIG_FILE : GLOBAL_CONFIG_FILE;
  const targetDir = isProject ? path.join(process.cwd(), '.seepient') : GLOBAL_CONFIG_DIR;

  console.log(chalk.bold.cyan("Seepient Agent Setup Wizard \n"));
  console.log(chalk.dim(`Config will be saved to: ${targetFile}`));

  const globalConfig = loadJsonConfig(GLOBAL_CONFIG_FILE);
  const localConfig = loadJsonConfig(LOCAL_CONFIG_FILE);
  const currentConfig = isProject
    ? { ...globalConfig, ...localConfig }
    : { ...localConfig, ...globalConfig };

  const anyExisting = currentConfig.models as Record<string, any> | undefined;

  // Step 1: Select providers to configure
  const { providers } = await inquirer.prompt([
    {
      type: 'checkbox',
      name: 'providers',
      message: 'Which providers do you want to configure?',
      choices: [
        { name: `OpenAI API Compatible${anyExisting?.['openai-compatible'] ? ' (configured)' : ''}`, value: 'openai-compatible', checked: !!anyExisting?.['openai-compatible'] },
        { name: `OpenAI Official${anyExisting?.openai ? ' (configured)' : ''}`, value: 'openai', checked: !!anyExisting?.openai },
        { name: `Anthropic Official${anyExisting?.anthropic ? ' (configured)' : ''}`, value: 'anthropic', checked: !!anyExisting?.anthropic },
        { name: `GLM Code Plan${anyExisting?.glm ? ' (configured)' : ''}`, value: 'glm', checked: !!anyExisting?.glm },
      ],
      validate: (input) => input.length > 0 ? true : 'Select at least one provider.'
    }
  ]);

  // Step 2: Per-provider configuration
  const modelsConfig: NonNullable<AppConfig['models']> = {};

  for (const p of providers as string[]) {
    const ex = anyExisting?.[p] as { apiKey?: string; baseUrl?: string; model?: string } | undefined;

    if (p === 'openai-compatible') {
      const answers = await inquirer.prompt([
        { type: 'password', name: 'apiKey', message: ex?.apiKey ? `OpenAI-Compatible API Key (Leave empty to keep ${maskSecret(ex.apiKey)}):` : 'OpenAI-Compatible API Key:', mask: '*', validate: (input: string) => (input || ex?.apiKey) ? true : 'API Key cannot be empty.' },
        { type: 'input', name: 'baseUrl', message: 'API Base URL:', default: ex?.baseUrl || currentConfig.baseUrl || 'https://api.openai.com/v1' },
        { type: 'input', name: 'model', message: 'Default Model:', default: ex?.model || currentConfig.model || DEFAULT_MODELS['openai-compatible'] }
      ]);
      modelsConfig['openai-compatible'] = { apiKey: answers.apiKey || ex?.apiKey || '', baseUrl: answers.baseUrl, model: answers.model };
    } else if (p === 'openai') {
      const answers = await inquirer.prompt([
        { type: 'password', name: 'apiKey', message: ex?.apiKey ? `OpenAI API Key (Leave empty to keep ${maskSecret(ex.apiKey)}):` : 'OpenAI API Key:', mask: '*', validate: (input: string) => (input || ex?.apiKey) ? true : 'API Key cannot be empty.' },
        { type: 'input', name: 'model', message: 'Default Model:', default: ex?.model || DEFAULT_MODELS.openai }
      ]);
      modelsConfig.openai = { apiKey: answers.apiKey || ex?.apiKey || '', model: answers.model };
    } else if (p === 'anthropic') {
      const answers = await inquirer.prompt([
        { type: 'password', name: 'apiKey', message: ex?.apiKey ? `Anthropic API Key (Leave empty to keep ${maskSecret(ex.apiKey)}):` : 'Anthropic API Key:', mask: '*', validate: (input: string) => (input || ex?.apiKey) ? true : 'API Key cannot be empty.' },
        { type: 'input', name: 'model', message: 'Default Model:', default: ex?.model || DEFAULT_MODELS.anthropic }
      ]);
      modelsConfig.anthropic = { apiKey: answers.apiKey || ex?.apiKey || '', model: answers.model };
    } else if (p === 'glm') {
      const keyAnswer = await inquirer.prompt<{ apiKey: string }>([{ type: 'password', name: 'apiKey', message: ex?.apiKey ? `GLM API Key (Leave empty to keep ${maskSecret(ex.apiKey)}):` : 'GLM API Key:', mask: '*', validate: (input: string) => (input || ex?.apiKey) ? true : 'API Key cannot be empty.' }]);
      const modelAnswer = await inquirer.prompt<{ model: string }>([{ type: 'list', name: 'model', message: 'Select Model:', choices: ['haiku', 'sonnet', 'opus'], default: ex?.model || DEFAULT_MODELS.glm }]);
      modelsConfig.glm = { apiKey: keyAnswer.apiKey || ex?.apiKey || '', model: modelAnswer.model };
    }
  }

  // Preserve or remove unselected providers
  const previouslyConfigured = anyExisting ? Object.keys(anyExisting) : [];
  const unselectedProviders = previouslyConfigured.filter((p: string) => !providers.includes(p));

  if (unselectedProviders.length > 0) {
    const { removeUnselected } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'removeUnselected',
        message: `The following providers are configured but were not selected: ${unselectedProviders.join(', ')}. Remove their configuration?`,
        default: false,
      },
    ]);
    if (!removeUnselected) {
      for (const p of unselectedProviders) {
        const existingEntry = anyExisting?.[p];
        if (existingEntry) {
          (modelsConfig as any)[p] = existingEntry;
        }
      }
    }
  }

  // Step 3: Default provider
  const { defaultProvider } = await inquirer.prompt([
    {
      type: 'list',
      name: 'defaultProvider',
      message: 'Which provider should be active by default?',
      choices: Object.keys(modelsConfig).map((p: string) => ({ name: p, value: p })),
      default: currentConfig.provider || providers[0]
    }
  ]);

  // Step 4: Optional extras
  const { configureImage } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'configureImage',
      message: 'Do you want to configure a separate Image Generation Service (DALL-E)?',
      default: !!currentConfig.imageApiKey
    }
  ]);
  const { configureEmail } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'configureEmail',
      message: 'Do you want to configure the Email Tool (SMTP)?',
      default: !!currentConfig.smtpHost
    }
  ]);
  const { configureSearch } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'configureSearch',
      message: 'Do you want to configure Web Search (Tavily)?',
      default: !!currentConfig.tavilyApiKey
    }
  ]);
  const { configureNotify } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'configureNotify',
      message: 'Do you want to configure Group Bots (Feishu/DingTalk/WeCom)?',
      default: !!(currentConfig.feishuWebhook || currentConfig.dingtalkWebhook || currentConfig.wecomWebhook)
    }
  ]);

  let imageConfig: any = {};
  if (configureImage) {
    const imageAnswers = await inquirer.prompt([
      {
        type: 'password',
        name: 'imageApiKey',
        message: currentConfig.imageApiKey
          ? `Enter Image Service API Key (Leave empty to keep ${maskSecret(currentConfig.imageApiKey)}, or leave empty to use main API key):`
          : 'Enter Image Service API Key (Leave empty to use main API key):',
        mask: '*'
      },
      {
        type: 'input',
        name: 'imageBaseUrl',
        message: 'Enter Image Service Base URL:',
        default: currentConfig.imageBaseUrl || currentConfig.baseUrl || 'https://api.openai.com/v1'
      },
      {
        type: 'input',
        name: 'imageModel',
        message: 'Default Image Model:',
        default: currentConfig.imageModel || 'dall-e-3'
      }
    ]);
    imageConfig = {
      imageApiKey: imageAnswers.imageApiKey || currentConfig.imageApiKey,
      imageBaseUrl: imageAnswers.imageBaseUrl,
      imageModel: imageAnswers.imageModel
    };
  }

  let emailConfig: any = {};
  if (configureEmail) {
     const emailAnswers = await inquirer.prompt([
      {
        type: 'input',
        name: 'smtpHost',
        message: 'SMTP Host:',
        default: currentConfig.smtpHost
      },
      {
        type: 'input',
        name: 'smtpPort',
        message: 'SMTP Port:',
        default: currentConfig.smtpPort || '587'
      },
      {
        type: 'input',
        name: 'smtpUser',
        message: 'SMTP Username:',
        default: currentConfig.smtpUser
      },
      {
        type: 'password',
        name: 'smtpPass',
        message: currentConfig.smtpPass
          ? `SMTP Password (Leave empty to keep ${maskSecret(currentConfig.smtpPass)}):`
          : 'SMTP Password:',
        mask: '*',
        validate: (input) => { return true; }
      },
      {
        type: 'input',
        name: 'smtpFrom',
        message: 'Sender Email Address (From):',
        default: currentConfig.smtpFrom || currentConfig.smtpUser
      }
    ]);
    emailConfig = { ...emailAnswers, smtpPass: emailAnswers.smtpPass || currentConfig.smtpPass };
    if (!emailConfig.smtpFrom && emailConfig.smtpUser) { emailConfig.smtpFrom = emailConfig.smtpUser; }
  }

  let searchConfig: any = {};
  if (configureSearch) {
    const searchAnswers = await inquirer.prompt([
      {
        type: 'password',
        name: 'tavilyApiKey',
        message: currentConfig.tavilyApiKey
          ? `Tavily API Key (Leave empty to keep ${maskSecret(currentConfig.tavilyApiKey)}):`
          : 'Tavily API Key (Free at tavily.com):',
        mask: '*'
      }
    ]);
    searchConfig = { tavilyApiKey: searchAnswers.tavilyApiKey || currentConfig.tavilyApiKey };
  }

  let notifyConfig: any = {};
  if (configureNotify) {
    const notifyAnswers = await inquirer.prompt([
      {
        type: 'password',
        name: 'feishuWebhook',
        message: currentConfig.feishuWebhook
          ? `Feishu Webhook (Leave empty to keep ${maskSecret(currentConfig.feishuWebhook)}):`
          : 'Feishu Webhook (Optional):',
        mask: '*'
      },
      {
        type: 'input',
        name: 'feishuKeyword',
        message: 'Feishu Security Keyword (Optional):',
        default: currentConfig.feishuKeyword
      },
      {
        type: 'password',
        name: 'dingtalkWebhook',
        message: currentConfig.dingtalkWebhook
          ? `DingTalk Webhook (Leave empty to keep ${maskSecret(currentConfig.dingtalkWebhook)}):`
          : 'DingTalk Webhook (Optional):',
        mask: '*'
      },
      {
        type: 'input',
        name: 'dingtalkKeyword',
        message: 'DingTalk Security Keyword (Optional):',
        default: currentConfig.dingtalkKeyword
      },
      {
        type: 'password',
        name: 'wecomWebhook',
        message: currentConfig.wecomWebhook
          ? `WeCom Webhook (Leave empty to keep ${maskSecret(currentConfig.wecomWebhook)}):`
          : 'WeCom Webhook (Optional):',
        mask: '*'
      },
      {
        type: 'input',
        name: 'wecomKeyword',
        message: 'WeCom Security Keyword (Optional):',
        default: currentConfig.wecomKeyword
      }
    ]);
    notifyConfig = {
      feishuWebhook: notifyAnswers.feishuWebhook || currentConfig.feishuWebhook,
      feishuKeyword: notifyAnswers.feishuKeyword || currentConfig.feishuKeyword,
      dingtalkWebhook: notifyAnswers.dingtalkWebhook || currentConfig.dingtalkWebhook,
      dingtalkKeyword: notifyAnswers.dingtalkKeyword || currentConfig.dingtalkKeyword,
      wecomWebhook: notifyAnswers.wecomWebhook || currentConfig.wecomWebhook,
      wecomKeyword: notifyAnswers.wecomKeyword || currentConfig.wecomKeyword
    };
  }

  const newConfig: AppConfig = {
    provider: defaultProvider,
    models: modelsConfig,
    ...imageConfig,
    ...emailConfig,
    ...searchConfig,
    ...notifyConfig
  };

  try {
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    fs.writeFileSync(targetFile, JSON.stringify(newConfig, null, 2), { mode: 0o600 });
    console.log(chalk.green(`\nConfiguration saved to ${targetFile}`));
    console.log(chalk.cyan("You can now run 'seepient' to start using the agent."));

    // Create ~/seepient_documents workspace
    const docsDir = path.join(os.homedir(), 'seepient_documents');
    const subdirs = ['notes', 'templates', 'output', 'knowledge'];
    if (!fs.existsSync(docsDir)) {
      fs.mkdirSync(docsDir, { recursive: true });
      for (const sub of subdirs) {
        fs.mkdirSync(path.join(docsDir, sub), { recursive: true });
      }
      fs.writeFileSync(
        path.join(docsDir, 'README.md'),
        `# seepient_documents\n\nThis is your Seepient agent workspace. Files here are accessible across all projects.\n\n- \`notes/\` — Agent-created notes and session logs\n- \`templates/\` — Reusable templates you or the agent can reference\n- \`output/\` — Generated artifacts (reports, summaries)\n- \`knowledge/\` — Reference documents for the agent to use\n\nReference files in conversation with \`@seepient_documents/path/to/file\`\n`,
        'utf-8'
      );
      console.log(chalk.green(`Created agent workspace at ${docsDir}`));
    }
  } catch (error: any) {
    console.error(chalk.red(`Failed to write config: ${error.message}`));
  }
}

// ── Inline provider management (used by /models command) ───────────────

async function addProviderInline(config: AppConfig): Promise<ProviderType | null> {
  const configured = Object.keys(config.models || {}) as ProviderType[];
  const available = ALL_PROVIDER_TYPES.filter(p => !configured.includes(p));

  if (available.length === 0) {
    console.log(chalk.yellow('All available providers are already configured.'));
    return null;
  }

  const { provider } = await inquirer.prompt<{ provider: ProviderType }>([
    {
      type: 'select',
      name: 'provider',
      message: 'Which provider to add?',
      choices: available.map(p => ({ name: p, value: p })),
    },
  ]);

  if (!config.models) config.models = {};

  if (provider === 'openai-compatible') {
    const answers = await inquirer.prompt([
      { type: 'password', name: 'apiKey', message: 'API Key:', mask: '*', validate: (input: string) => input ? true : 'API Key cannot be empty.' },
      { type: 'input', name: 'baseUrl', message: 'API Base URL:', default: 'https://api.openai.com/v1' },
      { type: 'input', name: 'model', message: 'Default Model:', default: DEFAULT_MODELS['openai-compatible'] },
    ]);
    config.models['openai-compatible'] = { apiKey: answers.apiKey, baseUrl: answers.baseUrl, model: answers.model };
  } else if (provider === 'openai') {
    const answers = await inquirer.prompt([
      { type: 'password', name: 'apiKey', message: 'OpenAI API Key:', mask: '*', validate: (input: string) => input ? true : 'API Key cannot be empty.' },
      { type: 'input', name: 'model', message: 'Default Model:', default: DEFAULT_MODELS.openai },
    ]);
    config.models.openai = { apiKey: answers.apiKey, model: answers.model };
  } else if (provider === 'anthropic') {
    const answers = await inquirer.prompt([
      { type: 'password', name: 'apiKey', message: 'Anthropic API Key:', mask: '*', validate: (input: string) => input ? true : 'API Key cannot be empty.' },
      { type: 'input', name: 'model', message: 'Default Model:', default: DEFAULT_MODELS.anthropic },
    ]);
    config.models.anthropic = { apiKey: answers.apiKey, model: answers.model };
  } else if (provider === 'glm') {
    const keyAnswer = await inquirer.prompt<{ apiKey: string }>([
      { type: 'password', name: 'apiKey', message: 'GLM API Key:', mask: '*', validate: (input: string) => input ? true : 'API Key cannot be empty.' },
    ]);
    const modelAnswer = await inquirer.prompt<{ model: string }>([
      { type: 'select', name: 'model', message: 'Select Model:', choices: ['haiku', 'sonnet', 'opus'], default: DEFAULT_MODELS.glm },
    ]);
    config.models.glm = { apiKey: keyAnswer.apiKey, model: modelAnswer.model };
  }

  saveConfig(config);
  console.log(chalk.green(`Added ${provider} to your configuration.`));
  return provider;
}

async function editProviderConfig(config: AppConfig, providerType: ProviderType): Promise<void> {
  if (!config.models) config.models = {};
  const ex = config.models?.[providerType] as { apiKey?: string; baseUrl?: string; model?: string } | undefined;

  if (providerType === 'openai-compatible') {
    const answers = await inquirer.prompt([
      { type: 'password', name: 'apiKey', message: ex?.apiKey ? `API Key (Leave empty to keep ${maskSecret(ex.apiKey)}):` : 'API Key:', mask: '*', validate: (input: string) => (input || ex?.apiKey) ? true : 'API Key cannot be empty.' },
      { type: 'input', name: 'baseUrl', message: 'API Base URL:', default: ex?.baseUrl || 'https://api.openai.com/v1' },
      { type: 'input', name: 'model', message: 'Default Model:', default: ex?.model || DEFAULT_MODELS['openai-compatible'] },
    ]);
    config.models!['openai-compatible'] = { apiKey: answers.apiKey || ex?.apiKey || '', baseUrl: answers.baseUrl, model: answers.model };
  } else if (providerType === 'openai') {
    const answers = await inquirer.prompt([
      { type: 'password', name: 'apiKey', message: ex?.apiKey ? `OpenAI API Key (Leave empty to keep ${maskSecret(ex.apiKey)}):` : 'OpenAI API Key:', mask: '*', validate: (input: string) => (input || ex?.apiKey) ? true : 'API Key cannot be empty.' },
      { type: 'input', name: 'model', message: 'Default Model:', default: ex?.model || DEFAULT_MODELS.openai },
    ]);
    config.models!.openai = { apiKey: answers.apiKey || ex?.apiKey || '', model: answers.model };
  } else if (providerType === 'anthropic') {
    const answers = await inquirer.prompt([
      { type: 'password', name: 'apiKey', message: ex?.apiKey ? `Anthropic API Key (Leave empty to keep ${maskSecret(ex.apiKey)}):` : 'Anthropic API Key:', mask: '*', validate: (input: string) => (input || ex?.apiKey) ? true : 'API Key cannot be empty.' },
      { type: 'input', name: 'model', message: 'Default Model:', default: ex?.model || DEFAULT_MODELS.anthropic },
    ]);
    config.models!.anthropic = { apiKey: answers.apiKey || ex?.apiKey || '', model: answers.model };
  } else if (providerType === 'glm') {
    const keyAnswer = await inquirer.prompt<{ apiKey: string }>([
      { type: 'password', name: 'apiKey', message: ex?.apiKey ? `GLM API Key (Leave empty to keep ${maskSecret(ex.apiKey)}):` : 'GLM API Key:', mask: '*', validate: (input: string) => (input || ex?.apiKey) ? true : 'API Key cannot be empty.' },
    ]);
    const modelAnswer = await inquirer.prompt<{ model: string }>([
      { type: 'list', name: 'model', message: 'Select Model:', choices: ['haiku', 'sonnet', 'opus'], default: ex?.model || DEFAULT_MODELS.glm },
    ]);
    config.models!.glm = { apiKey: keyAnswer.apiKey || ex?.apiKey || '', model: modelAnswer.model };
  }

  saveConfig(config);
  console.log(chalk.green(`Updated ${providerType} configuration.`));
}

async function removeProviderConfig(config: AppConfig, providerType: ProviderType): Promise<boolean> {
  const { confirm } = await inquirer.prompt<{ confirm: boolean }>([
    {
      type: 'confirm',
      name: 'confirm',
      message: `Remove ${providerType} config? This cannot be undone.`,
      default: false,
    },
  ]);

  if (!confirm) {
    console.log(chalk.dim('Removal cancelled.'));
    return false;
  }

  if (config.models) {
    delete config.models[providerType];
  }
  console.log(chalk.green(`Removed ${providerType} configuration.`));
  return true;
}

// ── Models command handler ─────────────────────────────────────────────

/**
 * Handle the /models interactive command.
 * Allows switching, editing, adding, and removing providers at runtime.
 */
export async function handleModelsCommand(
  agent: Agent,
  config: AppConfig,
  activeProvider: ProviderType,
): Promise<ProviderType> {
  // Guard: /models interactive switching requires a TTY
  if (isNonInteractive()) {
    console.log(chalk.yellow('Interactive model switching is not available in non-interactive mode.'));
    console.log(chalk.dim('Use --provider <name> or --model <model> flags, or set LLM_PROVIDER env var.'));
    return activeProvider;
  }

  if (!config.models) config.models = {};

  try {
    const configured = Object.keys(config.models).filter(
      k => (config.models as any)[k]?.apiKey
    ) as ProviderType[];

    if (configured.length === 0) {
      console.log(chalk.yellow('No providers configured. Let\'s add one.'));
      const added = await addProviderInline(config);
      if (!added) return activeProvider;
      return handleModelsCommand(agent, config, added);
    }

    // Step 1: Select provider
    const providerChoices = configured.map(p => ({
      name: `${p}${p === activeProvider ? ' (active)' : ''}`,
      value: p as ProviderType | typeof ADD_PROVIDER_VALUE,
    }));
    providerChoices.push({ name: 'Add a new provider...', value: ADD_PROVIDER_VALUE });

    const providerAnswer = await inquirer.prompt<{ selected: ProviderType | typeof ADD_PROVIDER_VALUE }>([
      {
        type: 'select',
        name: 'selected',
        message: 'Select a provider:',
        choices: providerChoices,
        default: activeProvider,
      },
    ]);

    if (providerAnswer.selected === ADD_PROVIDER_VALUE) {
      const added = await addProviderInline(config);
      if (!added) return handleModelsCommand(agent, config, activeProvider);
      return handleModelsCommand(agent, config, added);
    }

    const selected = providerAnswer.selected as ProviderType;

    // Step 2: Select action
    const actionAnswer = await inquirer.prompt<{ action: ProviderAction }>([
      {
        type: 'select',
        name: 'action',
        message: `Choose action for ${selected}:`,
        choices: [
          { name: 'Switch model', value: 'switch' as ProviderAction },
          { name: 'Edit config', value: 'edit' as ProviderAction },
          { name: 'Remove provider', value: 'remove' as ProviderAction },
          { name: '\u2190 Back', value: 'back' as ProviderAction },
        ],
      },
    ]);

    if (actionAnswer.action === 'back') {
      return handleModelsCommand(agent, config, activeProvider);
    }

    if (actionAnswer.action === 'edit') {
      await editProviderConfig(config, selected);
      // If editing the active provider, reload it
      if (selected === activeProvider) {
        const reloaded = await createProviderFromApp(config, selected);
        if (reloaded) {
          agent.switchProvider(selected, reloaded.model);
          console.log(chalk.green(`Reloaded ${selected} with updated config.`));
        }
      }
      return activeProvider;
    }

    if (actionAnswer.action === 'remove') {
      const removed = await removeProviderConfig(config, selected);
      if (removed) {
        if (selected === activeProvider) {
          // Fall back to first remaining configured provider
          const remaining = Object.keys(config.models || {}).filter(
            k => (config.models as any)[k]?.apiKey
          ) as ProviderType[];
          if (remaining.length > 0) {
            activeProvider = remaining[0];
            const switched = await createProviderFromApp(config, activeProvider);
            if (switched) {
              agent.switchProvider(activeProvider, switched.model);
              console.log(chalk.green(`Switched active provider to ${activeProvider}.`));
            }
            // Update config.provider to reflect new active provider
            config.provider = activeProvider;
          } else {
            console.log(chalk.yellow('No providers remaining. Use /models to add one.'));
          }
        }
        // Ensure config.provider doesn't reference a removed provider
        if (config.provider === selected) {
          delete config.provider;
        }
        saveConfig(config);
        return activeProvider;
      }
      return activeProvider;
    }

    // action === 'switch' — existing model selection flow
    const catalog = MODEL_CATALOG[selected];
    let model: string;

    if (catalog.length > 0) {
      const currentModel = config.models[selected]?.model || '';
      const modelChoices = catalog.map(m => ({
        name: m.name,
        value: m.id,
      }));
      modelChoices.push({ name: 'Type custom model...', value: CUSTOM_MODEL_VALUE });

      const modelAnswer = await inquirer.prompt<{ model: string }>([
        {
          type: 'select',
          name: 'model',
          message: `Select a model for ${selected}:`,
          choices: modelChoices,
          default: currentModel,
        },
      ]);

      if (modelAnswer.model === CUSTOM_MODEL_VALUE) {
        const customAnswer = await inquirer.prompt<{ model: string }>([
          {
            type: 'input',
            name: 'model',
            message: 'Enter model name:',
            default: currentModel,
          },
        ]);
        model = customAnswer.model;
      } else {
        model = modelAnswer.model;
      }
    } else {
      const customAnswer = await inquirer.prompt<{ model: string }>([
        {
          type: 'input',
          name: 'model',
          message: 'Enter model name:',
          default: config.models[selected]?.model || DEFAULT_MODELS['openai-compatible'],
        },
      ]);
      model = customAnswer.model;
    }

    config.models[selected]!.model = model;
    const created = await createProviderFromApp(config, selected, model);
    if (created) {
      agent.switchProvider(selected, created.model);
      console.log(chalk.green(`Switched to ${selected} (${model})`));
      return selected;
    } else {
      console.log(chalk.red(`Failed to resolve provider config for ${selected}`));
      return activeProvider;
    }
  } catch (err: any) {
    if (err.message?.includes('User force closed') || err.message?.includes('Prompt was canceled')) {
      console.log(chalk.dim('\nModel selection cancelled.'));
    } else {
      console.error(chalk.red('Error in models command:'), err.message);
    }
    return activeProvider;
  }
}
