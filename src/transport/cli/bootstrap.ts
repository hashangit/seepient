/**
 * Seepient CLI — Shared session bootstrap
 *
 * The setup phase that both dispatch paths need: config load + merge,
 * provider resolution (+ interactive setup wizard), permission level,
 * Agent construction, skills init, gateway init, and the documents dir.
 *
 * Extracted verbatim from `runChat()` so the readline fallback and the
 * Ink TUI share one setup path — no duplicated ~175 lines, and
 * `seepient -n` stays byte-identical (the setup prints only the same
 * interactive-gated status messages as before). UI chrome (welcome
 * banner, "agent initialized", the readline loop) stays in the caller.
 */

import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { Agent } from './agent.js';
import { resolveLaunchMode, selectSystemPrompt } from '../../domain/prompts/system-prompts.js';
import {
  configureProviders,
  loadProviderConfig,
  getProvider,
} from '../../domain/providers/provider-resolver.js';
import {
  loadJsonConfig,
  applyEnvOverrides,
  migrateLegacyFormat,
  getConfigPaths,
  getConfigDir,
} from './config-loader.js';
import { runSetup } from './setup.js';
import { isNonInteractive } from '../../foundations/environment.js';
import type { PermissionLevel, PersistenceBackend, ProviderType, GrantScope } from '../../foundations/types.js';
import { createPersistenceBackend } from '../../domain/sessions/session-store.js';
import { resolvePermissionLevel } from '../../domain/permission.js';
import { GrantStore } from '../../domain/grants.js';
import { SettingsManager } from '../../domain/settings/settings-manager.js';
import { loadMergedConfig } from './config-loader.js';

export interface CliSessionContext {
  agent: Agent;
  fullConfig: any;
  activeProviderType: string;
  providerConfig: any;
  permissionLevel: PermissionLevel | undefined;
  gatewayInstance: any;
  persistence: PersistenceBackend;
}

export async function bootstrapCliSession(options: any): Promise<CliSessionContext> {
  const { global: GLOBAL_CONFIG_FILE, local: LOCAL_CONFIG_FILE } = getConfigPaths();

  // 1. Load and merge configs (local > global)
  const globalConfig = loadJsonConfig(GLOBAL_CONFIG_FILE);
  const localConfig = loadJsonConfig(LOCAL_CONFIG_FILE);
  if (Object.keys(localConfig).length > 0 && options.interactive) {
    console.log(chalk.dim(`Loaded project config from ${LOCAL_CONFIG_FILE}`));
  }

  let fullConfig = { ...globalConfig, ...localConfig };

  // T3: create session SnapshotStore for hash-anchored edits
  const { createSnapshotStore } = await import('../../foundations/hashline/snapshot-store.js');
  const snapshotStore = createSnapshotStore();
  (fullConfig as any).snapshotStore = snapshotStore;

  // 2. Inject runtime flags
  fullConfig.autoConfirm = options.yes || options.headless || options.docker || false;

  // 2b. Resolve permission level from CLI flags, env var, and config
  let permissionLevel: PermissionLevel | undefined;
  const headless = options.headless || options.yes || options.docker;

  if (!headless) {
    const flagLevel = options.yolo ? "permissive"
      : options.strict ? "strict"
      : options.moderate ? "moderate"
      : undefined;
    permissionLevel = resolvePermissionLevel(
      flagLevel,
      process.env.SEEPIENT_PERMISSION,
      fullConfig.permissionLevel,
    );
  }

  // Warn about conflicting flags
  if (headless && (options.strict || options.moderate || options.yolo)) {
    const flag = options.strict ? '--strict' : options.moderate ? '--moderate' : '--yolo';
    console.warn(`Warning: --headless overrides ${flag}. All tools will be auto-approved.`);
  }

  // 3. Auto-migrate legacy config format (top-level apiKey/baseUrl/model)
  //    Must run BEFORE applyEnvOverrides, which initializes models={} and would
  //    block the !config.models guard in migrateLegacyFormat.
  fullConfig = migrateLegacyFormat(fullConfig, { model: options.model });

  // 4. Apply env var overrides for tool settings
  fullConfig = applyEnvOverrides(fullConfig);

  // 5. Load provider config via unified resolution
  const cliProvider = options.provider;
  let multiConfig = loadProviderConfig(fullConfig, cliProvider);

  if (!multiConfig) {
    console.log(chalk.yellow("No provider configuration found."));

    if (isNonInteractive()) {
      console.error(chalk.red("No provider configured. Set API key env vars (OPENAI_API_KEY / ANTHROPIC_API_KEY / GLM_API_KEY) or provide a config file."));
      process.exit(1);
    } else {
      const inquirer = await import('inquirer');
      const { doSetup } = await inquirer.default.prompt([
        {
          type: 'confirm',
          name: 'doSetup',
          message: 'Would you like to run the setup wizard now?',
          default: true
        }
      ]);

      if (doSetup) {
        await runSetup();
        const newConfig = loadJsonConfig(GLOBAL_CONFIG_FILE);
        Object.assign(fullConfig, newConfig);
        multiConfig = loadProviderConfig(fullConfig, cliProvider);
      } else {
        console.error(chalk.red("Provider configuration is required to proceed."));
        process.exit(1);
      }
    }
  }

  if (!multiConfig) {
    console.error(chalk.red("Provider configuration is still missing. Exiting."));
    process.exit(1);
  }

  configureProviders(multiConfig);

  // Active provider: CLI --provider flag → multiConfig.default
  const activeProviderType = (cliProvider as string) ?? multiConfig.default;

  // getProvider handles model override so it's baked into the provider instance
  const { provider, model } = await getProvider(activeProviderType as any, options.model);
  const providerConfig = { type: activeProviderType, model };
  // Select system prompt by launch mode: interactive (TUI/readline in a TTY)
  // gets the interactive coding-agent prompt; headless/docker/piped keep
  // the Docker-native prompt unchanged.
  const launchMode = resolveLaunchMode(options);
  const systemPrompt = selectSystemPrompt(launchMode);
  // Session persistence — single file backend shared by the REPL, TUI, and the
  // session selector overlay. Default path is ~/.seepient/sessions (see Core's
  // defaultSessionPath()). Disabled backends can be added via registerBackend().
  const persistence = createPersistenceBackend({ type: 'file' });
  const agent = new Agent(provider, model, fullConfig, systemPrompt, persistence, activeProviderType as ProviderType);

  // Tool-approval grant store: project grants at <cwd>/.seepient/grants.json,
  // global at ~/.seepient/grants.json. Consulted by the agent loop so matching
  // tool calls skip the approval prompt; managed via /permissions.
  const grantStore = new GrantStore({
    projectDir: getConfigDir(false),
    globalDir: getConfigDir(true),
  });
  agent.setGrantStore(grantStore);

  // Pre-seed grants from --allow-* flags (repeatable, scope-specific):
  //   --allow-once / --allow-session → session scope (process lifetime;
  //     equivalent in non-interactive mode — one run = one session)
  //   --allow-project                 → project scope (<cwd>/.seepient/grants.json)
  //   --allow-global                  → global scope  (~/.seepient/grants.json)
  // Spec format per flag: "tool" or "tool:pattern". Lets a headless/CI run
  // pre-authorize specific tools (optionally scoped by arg prefix) without
  // the blanket --yes / --headless auto-approval.
  const allowFlags: Array<{ specs: string[]; scope: GrantScope }> = [
    { specs: options.allowOnce ?? [], scope: 'session' },
    { specs: options.allowSession ?? [], scope: 'session' },
    { specs: options.allowProject ?? [], scope: 'project' },
    { specs: options.allowGlobal ?? [], scope: 'global' },
  ];
  for (const { specs, scope } of allowFlags) {
    for (const spec of specs) {
      const sep = spec.indexOf(':');
      const tool = (sep === -1 ? spec : spec.slice(0, sep)).trim();
      const pattern = sep === -1 ? undefined : spec.slice(sep + 1).trim();
      if (tool.length > 0) {
        await grantStore.add(tool, scope, pattern || undefined);
      }
    }
  }

  // Initialize skills system
  await agent.initializeSkills();

  // Initialize gateway (if enabled)
  let gatewayInstance: any = null;
  try {
    const settingsManager = new SettingsManager({
      config: applyEnvOverrides(loadMergedConfig()),
      projectConfigPath: LOCAL_CONFIG_FILE,
      globalConfigPath: GLOBAL_CONFIG_FILE,
    });
    const gwEnabled = settingsManager.get('gateway.enabled').value as boolean;
    if (gwEnabled) {
      const gatewayConfig = {
        enabled: true,
        semanticTopK: settingsManager.get('gateway.semanticTopK').value as number,
        defaultRateLimitPerMin: settingsManager.get('gateway.defaultRateLimitPerMin').value as number,
        maxAuditLogsInMemory: settingsManager.get('gateway.maxAuditLogs').value as number,
      };
      const { GatewaySettingsAdapter } = await import('../../capabilities/gateway/settings-adapter.js');
      const gwStorageDir = process.env.SEEPIENT_GATEWAY_DIR ?? path.join(os.homedir(), '.seepient');
      const gwSettingsAdapter = new GatewaySettingsAdapter(gwStorageDir);
      await gwSettingsAdapter.initialize();

      const { createGateway } = await import('../../capabilities/gateway/index.js');
      const { registerTool } = await import('../../domain/tool-executor.js');
      gatewayInstance = await createGateway(gatewayConfig, gwSettingsAdapter, undefined, (tools) => tools.forEach(registerTool));

      if (gatewayInstance) {
        const { semanticToolInjectionMiddleware } = await import('../../domain/middleware/semantic-tools.js');
        agent.setMiddleware([semanticToolInjectionMiddleware(gatewayInstance, gatewayConfig.semanticTopK)]);
        if (options.interactive) {
          console.log(chalk.green('Gateway initialized'));
        }
      }
    }
  } catch (e) {
    console.warn(chalk.yellow(`Gateway initialization skipped: ${e instanceof Error ? e.message : String(e)}`));
  }

  // Ensure ~/seepient_documents exists
  const docsDir = path.join(os.homedir(), 'seepient_documents');
  if (!fs.existsSync(docsDir)) {
    fs.mkdirSync(docsDir, { recursive: true });
    for (const sub of ['notes', 'templates', 'output', 'knowledge']) {
      fs.mkdirSync(path.join(docsDir, sub), { recursive: true });
    }
  }

  // Session TTL cleanup — sweep expired sessions on startup (once, no timer).
  // Runs before --resume so an expired target is gone before we try to load it.
  try {
    const settingsManager = new SettingsManager({
      config: applyEnvOverrides(loadMergedConfig()),
      projectConfigPath: LOCAL_CONFIG_FILE,
      globalConfigPath: GLOBAL_CONFIG_FILE,
    });
    const maxAgeDays = settingsManager.get('sessions.maxAgeDays').value as number;
    if (maxAgeDays && maxAgeDays > 0) {
      const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
      const cutoff = Date.now() - maxAgeMs;
      const ids = await persistence.list();
      await Promise.all(ids.map(async (id) => {
        const data = await persistence.load(id);
        if (data && data.updatedAt < cutoff) await persistence.delete(id);
      }));
    }
  } catch { /* best-effort — never block startup on cleanup */ }

  // --resume <id|last> — load a session before the REPL/TUI starts.
  if (options.resume) {
    let resumeId = options.resume as string;
    if (resumeId === 'last') {
      const ids = await persistence.list();
      if (ids.length === 0) {
        console.error(chalk.red('No saved sessions to resume.'));
        process.exit(1);
      }
      const loaded = await Promise.all(ids.map((id) => persistence.load(id)));
      const mostRecent = loaded
        .filter((s): s is NonNullable<typeof s> => s != null)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (!mostRecent) {
        console.error(chalk.red('No saved sessions to resume.'));
        process.exit(1);
      }
      resumeId = mostRecent.id;
    }
    const ok = await agent.loadSession(resumeId);
    if (!ok) {
      console.error(chalk.red(`Session "${resumeId}" not found. Use /sessions in the TUI to list available sessions.`));
      process.exit(1);
    }
    if (options.interactive !== false) console.log(chalk.dim(`Resumed session ${resumeId.slice(0, 8)}.`));
  }

  return { agent, fullConfig, activeProviderType, providerConfig, permissionLevel, gatewayInstance, persistence };
}
