/**
 * Seepient CLI — Setup Wizard
 *
 * Interactive setup wizard for configuring API keys and providers via ProviderConfigStore.
 */

import inquirer from 'inquirer';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getDefaultProviderRuntime } from '../../domain/providers/provider-runtime.js';
import { Agent } from './agent.js';
import {
  type AppConfig,
  getConfigPaths,
  loadJsonConfig,
  maskSecret,
} from './config-loader.js';
import { isNonInteractive } from '../../foundations/environment.js';

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

  const runtime = getDefaultProviderRuntime();
  const configStore = runtime.getConfigStore();
  const effectiveConfig = await configStore.getEffectiveConfig();
  const existingProviders = effectiveConfig.providers || {};

  // Step 1: Select providers to configure
  const { providers } = await inquirer.prompt([
    {
      type: 'checkbox',
      name: 'providers',
      message: 'Which providers do you want to configure?',
      choices: [
        { name: `OpenAI Official${existingProviders['openai'] ? ' (configured)' : ''}`, value: 'openai', checked: !!existingProviders['openai'] },
        { name: `Anthropic Official${existingProviders['anthropic'] ? ' (configured)' : ''}`, value: 'anthropic', checked: !!existingProviders['anthropic'] },
        { name: `GLM Code Plan${existingProviders['glm'] ? ' (configured)' : ''}`, value: 'glm', checked: !!existingProviders['glm'] },
        { name: `OpenAI API Compatible${existingProviders['openai-compatible'] ? ' (configured)' : ''}`, value: 'openai-compatible', checked: !!existingProviders['openai-compatible'] },
      ],
      validate: (input) => input.length > 0 ? true : 'Select at least one provider.'
    }
  ]);

  // Step 2: Per-provider configuration
  const overlayPatchProviders: Record<string, any> = {};

  for (const p of providers as string[]) {
    const ex = existingProviders[p];

    if (p === 'openai') {
      const answers = await inquirer.prompt([
        { type: 'password', name: 'apiKey', message: 'OpenAI API Key:', mask: '*', validate: (input: string) => input ? true : 'API Key cannot be empty.' },
        { type: 'input', name: 'model', message: 'Default Model:', default: 'gpt-4o' }
      ]);
      overlayPatchProviders['openai'] = {
        adapter: 'pi-ai',
        upstreamProvider: 'openai',
        credential: { kind: 'direct', value: answers.apiKey },
      };
    } else if (p === 'anthropic') {
      const answers = await inquirer.prompt([
        { type: 'password', name: 'apiKey', message: 'Anthropic API Key:', mask: '*', validate: (input: string) => input ? true : 'API Key cannot be empty.' },
        { type: 'input', name: 'model', message: 'Default Model:', default: 'claude-3-7-sonnet-latest' }
      ]);
      overlayPatchProviders['anthropic'] = {
        adapter: 'pi-ai',
        upstreamProvider: 'anthropic',
        credential: { kind: 'direct', value: answers.apiKey },
      };
    } else if (p === 'glm') {
      const answers = await inquirer.prompt([
        { type: 'password', name: 'apiKey', message: 'GLM API Key:', mask: '*', validate: (input: string) => input ? true : 'API Key cannot be empty.' },
        { type: 'input', name: 'model', message: 'Default Model:', default: 'glm-4-plus' }
      ]);
      overlayPatchProviders['glm'] = {
        adapter: 'pi-ai',
        upstreamProvider: 'glm',
        credential: { kind: 'direct', value: answers.apiKey },
      };
    } else if (p === 'openai-compatible') {
      const answers = await inquirer.prompt([
        { type: 'password', name: 'apiKey', message: 'API Key:', mask: '*', validate: (input: string) => input ? true : 'API Key cannot be empty.' },
        { type: 'input', name: 'baseUrl', message: 'API Base URL:', default: 'https://api.openai.com/v1' },
        { type: 'input', name: 'model', message: 'Default Model:', default: 'gpt-4o' }
      ]);
      overlayPatchProviders['openai-compatible'] = {
        adapter: 'pi-ai',
        upstreamProvider: 'openai-compatible',
        baseUrl: answers.baseUrl,
        credential: { kind: 'direct', value: answers.apiKey },
      };
    }
  }

  // Step 3: Default provider
  const { defaultProvider } = await inquirer.prompt([
    {
      type: 'list',
      name: 'defaultProvider',
      message: 'Which provider should be active by default?',
      choices: Object.keys(overlayPatchProviders).map((p: string) => ({ name: p, value: p })),
      default: providers[0]
    }
  ]);

  const defaultModelMap: Record<string, string> = {
    openai: 'gpt-4o',
    anthropic: 'claude-3-7-sonnet-latest',
    glm: 'glm-4-plus',
    'openai-compatible': 'gpt-4o',
  };

  const overlay = await configStore.getOverlay();
  await configStore.updateOverlay({
    providers: overlayPatchProviders,
    modelAssignments: {
      text: {
        standard: {
          providerAccount: defaultProvider,
          model: defaultModelMap[defaultProvider] || 'default',
        },
      },
    } as any,
  }, overlay.revision);

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
        default: currentConfig.imageBaseUrl || 'https://api.openai.com/v1'
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
        validate: (_input) => true
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

// ── Models command handler ─────────────────────────────────────────────

/**
 * Handle the /models interactive command.
 * Allows switching and listing providers via ProviderRuntime.
 */
export async function handleModelsCommand(
  agent: Agent,
  _config: AppConfig,
  activeProvider: string,
): Promise<string> {
  if (isNonInteractive()) {
    console.log(chalk.yellow('Interactive model switching is not available in non-interactive mode.'));
    console.log(chalk.dim('Use --provider <name> or --model <model> flags.'));
    return activeProvider;
  }

  const runtime = agent.getProviderRuntime() ?? getDefaultProviderRuntime();
  const configStore = runtime.getConfigStore();
  const effectiveConfig = await configStore.getEffectiveConfig();
  const providers = Object.keys(effectiveConfig.providers || {});

  if (providers.length === 0) {
    console.log(chalk.yellow('No providers configured. Running setup...'));
    await runSetup();
    return activeProvider;
  }

  const choices = providers.map(p => ({
    name: `${p}${p === activeProvider ? ' (active)' : ''}`,
    value: p,
  }));

  const { selected } = await inquirer.prompt<{ selected: string }>([
    {
      type: 'list',
      name: 'selected',
      message: 'Select an active provider account:',
      choices,
      default: activeProvider,
    },
  ]);

  const { model } = await inquirer.prompt<{ model: string }>([
    {
      type: 'input',
      name: 'model',
      message: `Enter model name for ${selected}:`,
      default: effectiveConfig.modelAssignments?.text?.standard?.model || 'gpt-4o',
    },
  ]);

  agent.switchProvider(selected, model);
  console.log(chalk.green(`Switched active provider to ${selected} (${model})`));
  return selected;
}
