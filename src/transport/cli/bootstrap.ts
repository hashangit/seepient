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
import * as readline from 'readline/promises';

import { Agent } from './agent.js';
import { ToolRegistry } from '../../domain/tool-executor.js';
import { resolveLaunchMode, selectSystemPrompt } from '../../domain/prompts/system-prompts.js';
import { getDefaultProviderRuntime } from '../../domain/providers/provider-runtime.js';
import {
  loadJsonConfig,
  applyEnvOverrides,
  getConfigPaths,
  getConfigDir,
} from './config-loader.js';
import { runSetup } from './setup.js';
import { isNonInteractive } from '../../foundations/environment.js';
import { type ConsentMode, consentModeToApprovalMode } from '../../foundations/settings-schema.js';
import { VALID_CONSENT_MODES } from '../../foundations/config.js';
import type { PersistenceBackend } from '../../foundations/types.js';
import { createPersistenceBackend } from '../../domain/sessions/session-store.js';
import { SettingsManager } from '../../domain/settings/settings-manager.js';
import { loadMergedConfig } from './config-loader.js';

export interface CliSessionContext {
  agent: Agent;
  fullConfig: any;
  activeProviderType: string;
  providerConfig: any;
  consentMode: ConsentMode;
  gatewayInstance: any;
  persistence: PersistenceBackend;
}

export function resolveRuntimeFlags(
  options: any = {},
  baseConfig: any = {},
): { autoConfirm: boolean; consentMode: ConsentMode } {
  // FR-019: --docker and --headless stop setting autoConfirm; only options.yes sets autoConfirm
  const autoConfirm = Boolean(options.yes);

  const rawConsentMode =
    (options.yes ? 'autonomous' : undefined) ||
    options.mode ||
    options.consentMode ||
    process.env.SEEPIENT_CONSENT_MODE ||
    baseConfig.consentMode;
  if (process.env.SEEPIENT_CONSENT_MODE && !VALID_CONSENT_MODES.includes(process.env.SEEPIENT_CONSENT_MODE as ConsentMode)) {
    console.warn(
      `[seepient] Warning: Unrecognized SEEPIENT_CONSENT_MODE "${process.env.SEEPIENT_CONSENT_MODE}". Valid options: ask-everything, edit-enabled, autonomous. Falling back to edit-enabled.`,
    );
  } else if (rawConsentMode && !VALID_CONSENT_MODES.includes(rawConsentMode)) {
    console.warn(
      `[seepient] Warning: Unrecognized consent mode "${rawConsentMode}". Valid options: ask-everything, edit-enabled, autonomous. Falling back to edit-enabled.`,
    );
  }
  const consentMode: ConsentMode = VALID_CONSENT_MODES.includes(rawConsentMode)
    ? (rawConsentMode as ConsentMode)
    : 'edit-enabled';

  return { autoConfirm, consentMode };
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
  const { autoConfirm, consentMode } = resolveRuntimeFlags(options, fullConfig);
  fullConfig.autoConfirm = autoConfirm;

  // 3. Apply env var overrides for tool settings
  fullConfig = applyEnvOverrides(fullConfig);

  // 5. Load provider config via ProviderRuntime
  const runtime = getDefaultProviderRuntime();
  let effectiveConfig = await runtime.getConfigStore().getEffectiveConfig();
  let hasProviders = Object.keys(effectiveConfig.providers || {}).length > 0;

  if (!hasProviders) {
    console.log(chalk.yellow("No provider configuration found."));

    if (isNonInteractive()) {
      console.error(chalk.red("No provider configured. Set supported API key env vars (OPENAI_API_KEY / ANTHROPIC_API_KEY / GLM_API_KEY / OPENAI_COMPAT_API_KEY) or configure via `seepient providers add <id> --credential env:VAR_NAME`."));
      process.exit(1);
    } else {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        const raw = await rl.question(chalk.cyan("No provider configured. Run setup wizard now? [Y/n] "));
        const ans = raw.trim().toLowerCase();
        if (ans === "n" || ans === "no") {
          console.log(chalk.dim("Setup skipped. You can configure providers anytime using `seepient setup` or `seepient providers add`."));
          process.exit(0);
        }
      } finally {
        rl.close();
      }
      await runSetup();
      effectiveConfig = await runtime.getConfigStore().getEffectiveConfig();
      hasProviders = Object.keys(effectiveConfig.providers || {}).length > 0;

      if (!hasProviders) {
        console.error(chalk.red("Provider configuration is required to proceed."));
        process.exit(1);
      }
    }
  }

  const cliProvider = options.provider as string | undefined;
  const snapshot = await runtime.createTurnSnapshot();
  let resolvedModel = options.model || '';
  let activeProviderType = cliProvider || '';

  try {
    const plan = await runtime.resolvePlan(
      snapshot,
      'text',
      'standard',
      options.model || cliProvider ? { model: options.model, providerAccount: cliProvider } : undefined,
    );
    resolvedModel = plan.selectedTarget.model;
    activeProviderType = plan.selectedTarget.providerAccount;
  } catch {
    if (!activeProviderType) {
      activeProviderType = Object.keys(effectiveConfig.providers || {})[0] || 'default';
    }
    if (!resolvedModel) {
      resolvedModel = options.model || 'default';
    }
  }

  const providerConfig = { type: activeProviderType, model: resolvedModel };
  // Select system prompt by launch mode: interactive (TUI/readline in a TTY)
  // gets the interactive coding-agent prompt; headless/docker/piped keep
  // the Docker-native prompt unchanged.
  const launchMode = resolveLaunchMode(options);
  const systemPrompt = selectSystemPrompt(launchMode);
  // Session persistence — single file backend shared by the REPL, TUI, and the
  // session selector overlay. Default path is ~/.seepient/sessions (see Core's
  // defaultSessionPath()). Disabled backends can be added via registerBackend().
  fullConfig.hasExplicitModel = Boolean(options.model);
  const persistence = createPersistenceBackend({ type: 'file' });
  const toolRegistry = new ToolRegistry();
  const agent = new Agent(runtime, options.model ?? resolvedModel, fullConfig, systemPrompt, persistence, activeProviderType, toolRegistry);
  if (cliProvider) {
    agent.switchProvider(cliProvider, options.model ?? resolvedModel);
  }

  // Initialize skills system
  await agent.initializeSkills();

  // Initialize gateway (if enabled) — register returned tools into per-agent registry (Spec 022)
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
      const gwResult = await createGateway(gatewayConfig, gwSettingsAdapter);

      if (gwResult) {
        gatewayInstance = gwResult.gateway;
        agent.registerManyTools(gwResult.tools);
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

  // Spec 008 / 017: attach the protected PolicyStore. Active policy lives
  // at ~/.seepient/security/policies/<workspace-id>.json — outside executor-
  // writable roots. /permissions propose|review|approve|revoke-cap route
  // through compare-and-set; proposals are inert until approved.
  try {
    const { LocalPolicyStore, computeWorkspaceId } = await import(
      '../../domain/permissions/policy-store.js'
    );
    const policyStore = new LocalPolicyStore();
    const workspaceId = computeWorkspaceId(process.cwd());
    agent.setPolicyStore(policyStore, workspaceId);
    // Spec 011 (T033 + settings): the approval deadline comes from
    // `permissions.approvalTimeoutMs` (default ten minutes). Read it here
    // so the request expiry and the inline broker cutoff both honor it.
    const deadlineSettings = new SettingsManager({
      config: applyEnvOverrides(loadMergedConfig()),
      projectConfigPath: LOCAL_CONFIG_FILE,
      globalConfigPath: GLOBAL_CONFIG_FILE,
    });
    // The value is captured when the pipeline is constructed (restart to
    // change, per the settings metadata), so clamp any out-of-range input
    // here — env overrides bypass the SettingsManager set() validation
    // (P1 review fix).
    const rawDeadline = deadlineSettings.get(
      'permissions.approvalTimeoutMs',
    ).value as number;
    const approvalDeadlineMs = Number.isFinite(rawDeadline)
      ? Math.min(Math.max(rawDeadline, 10_000), 3_600_000)
      : 600_000;
    let effectiveConsentMode: ConsentMode = consentMode;
    if (!options.mode && !options.consentMode) {
      const settingVal = deadlineSettings.get('permissions.consentMode')?.value;
      if (settingVal != null && settingVal !== '') {
        const strVal = String(settingVal);
        if (VALID_CONSENT_MODES.includes(strVal as ConsentMode)) {
          effectiveConsentMode = strVal as ConsentMode;
        } else {
          console.warn(
            `[seepient] Warning: Unrecognized consent mode "${strVal}" in settings. Valid options: ask-everything, edit-enabled, autonomous. Falling back to edit-enabled.`,
          );
        }
      }
    }

    const approvalMode = consentModeToApprovalMode(effectiveConsentMode);

    await agent.enablePermissionPipeline({
      workspaceRoot: process.cwd(),
      modelProviderClass: activeProviderType ?? 'openai',
      approvalDeadlineMs,
      approvalMode,
      // spec 019 FR-001: the session store bootstrap already owns (line ~62)
      // drives read-side tagging and edit_file analysis.
      snapshotStore: (fullConfig as any).snapshotStore,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      chalk.red(`[permissions] Permission pipeline failed to initialize: ${message}`),
    );
    agent.setPipelineInitError?.(message);
    console.error(
      chalk.red('[permissions] Refusing to start: the protected permission pipeline could not be initialized.'),
    );
    process.exit(1);
  }

  // T109c: Audit recovery — reload durable outbox + scan for dispatched
  // records without a terminal event on startup. Best-effort, never blocks.
  try {
    const { LocalAuditStore, TerminalEventOutbox, recoverIndeterminateActions } = await import(
      '../../domain/permissions/audit-recorder.js'
    );
    const auditStore = new LocalAuditStore();
    const outbox = new TerminalEventOutbox(auditStore);
    await outbox.reload();
    if (!outbox.isHealthy()) {
      const remaining = await outbox.flush();
      if (remaining > 0 && process.env.DEBUG) {
        console.warn(`[audit] ${remaining} terminal event(s) still pending after startup flush`);
      }
    }
    const recovered = await recoverIndeterminateActions(auditStore, outbox);
    if (recovered.length > 0 && process.env.DEBUG) {
      console.warn(`[audit] Recovered ${recovered.length} indeterminate action(s): ${recovered.join(', ')}`);
    }
  } catch { /* best-effort — never block startup on audit recovery */ }

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
      const rawList = await persistence.list?.() ?? [];
      const ids = rawList.map((item: any) => typeof item === "string" ? item : item.id);
      await Promise.all(ids.map(async (id) => {
        const data = await persistence.load(id);
        if (data && data.updatedAt < cutoff) await persistence.delete?.(id);
      }));
    }
  } catch { /* best-effort — never block startup on cleanup */ }

  // --resume <id|last> — load a session before the REPL/TUI starts.
  if (options.resume) {
    let resumeId = options.resume as string;
    if (resumeId === 'last') {
      const rawList = await persistence.list?.() ?? [];
      const ids = rawList.map((item: any) => typeof item === "string" ? item : item.id);
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

  return { agent, fullConfig, activeProviderType, providerConfig, consentMode, gatewayInstance, persistence };
}
