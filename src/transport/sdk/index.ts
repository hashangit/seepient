/**
 * Seepient SDK — Public entry point
 *
 * Exports `askSeepient`, `createSeepient`, and all public types,
 * tool factories, provider helpers, and skill utilities.
 */

import type {
  AskSeepientOptions,
  AskSeepientResult,
  AskSeepientStreamResult,
  Message,
  StepResult,
  ToolCall,
  Usage,
  SeepientError,
} from "../../foundations/types.js";
import { createAmbientProviderRuntime, createIsolatedProviderRuntime, type ProviderRuntime } from "../../domain/providers/provider-runtime.js";
import { createHookExecutor } from "../../domain/hooks.js";
import { StreamManager } from "../../domain/streaming/stream-manager.js";
import { resolveTools, extractHostCallbacks, extractRegistrations, DEFAULT_TRUSTED_HOST_ALLOWLIST } from "./tools.js";
import { ToolRegistry } from "../../domain/tool-executor.js";
import type { ToolModule } from "../../foundations/contracts/tool.js";
import { runAgentLoop } from "../../domain/agent-loop.js";
import { initializeSkillRegistry } from "../../capabilities/skills/index.js";
import { validateSessionId } from "./seepient.js";
import { buildSkillCatalog } from "../../domain/skills/skill-catalog.js";
import {
  now,
  toSeepientError,
} from "../../domain/context/message-convert.js";
import { generateId } from "../../foundations/id.js";
import { extractLoopError } from "./error-surfacing.js";
import type { Middleware } from "../../foundations/contracts/middleware.js";
import { homedir } from 'os';
import * as path from 'path';

// ── Re-exports ───────────────────────────────────────────────────────────

export {
  createSeepient,
  createTenantAgent,
  validateSessionId,
  MAX_SESSION_ID_LENGTH,
  type CreateTenantAgentOptions,
} from "./seepient.js";
export type {
  Seepient,
  CreateSeepientOptions,
} from "../../foundations/types.js";
export type { CredentialStore } from "../../foundations/contracts/credential-store.js";
export type {
  AccountInput,
  SaveResult,
  DeleteResult,
  AssignmentTarget,
  UiError,
  ManagerState,
  ProviderManagerApi,
  ResolutionPreview,
  ProbeResult,
} from "../../foundations/contracts/provider-manager-api.js";
export { createProviderManagerApi, isOAuthSupported, getCanonicalOAuthFlowId } from "../cli/provider-manager-api.js";
export { tool, CORE_TOOLS, COMM_TOOLS, ADVANCED_TOOLS, ALL_TOOLS } from "./tools.js";
export {
  preparedTool,
  brokerConnector,
  trustedHostTool,
  type AnyToolRegistration,
  type TrustedHostToolRegistration,
  type PreparedToolRegistration,
  type BrokerConnectorRegistration,
  type LegacyHostToolRegistration,
  type HostToolContext,
} from "./custom-tools.js";
/**
 * @warning Profile A only. Ambient configuration access reading from ~/.seepient/setting.json.
 * Do not use in multi-tenant environments.
 */
export { settings, SettingsError } from "./settings.js";
/**
 * @warning Profile A only. Ambient operator provider runtime reading process.env credentials and host dotfiles.
 * For multi-tenant hosting, use createIsolatedProviderRuntime() or new ProviderRuntime() instead.
 */
export { createAmbientProviderRuntime, createIsolatedProviderRuntime, ProviderRuntime } from "../../domain/providers/provider-runtime.js";
export { ProviderConfigStore } from "../../domain/providers/config-store/provider-config-store.js";
export { MemoryCredentialStore } from "../../domain/providers/credentials/memory-credential-store.js";
export type { AuditStore, PolicyStore, ActionAuditEvent, PolicySnapshot } from "../../foundations/contracts/execution-brokers.js";
export type { CapabilityLedger, RevokeFilter } from "../../foundations/contracts/capability-ledger.js";
export type { CapabilitySet, DecisionAuthority, ApprovalBroker, PermissionRequest, PermissionDecision } from "../../foundations/contracts/permission-policy.js";
export type { ProviderRuntimeContract } from "../../foundations/contracts/provider-runtime.js";
export type { ConsentMode } from "../../foundations/settings-schema.js";
export type {
  SkillRecord,
  SkillSource,
  SkillStore,
  SkillLiteral,
} from "../../foundations/contracts/skill-source.js";
export { FsSkillSources } from "../../capabilities/skills/fs-skill-sources.js";
/**
 * @warning Profile A only. Ambient skill registry initialization discovering skills from host dotfiles and local directories.
 * In multi-tenant mode, inject explicit SkillSource instances instead.
 */
export { initializeSkillRegistry } from "../../capabilities/skills/index.js";
export {
  saveGeneratedSkill,
  type SaveGeneratedSkillParams,
  type SaveGeneratedSkillResult,
} from "../../domain/skills/generated-skill-save.js";
export {
  SeepientError,
  InferenceError,
  ProviderError,
  ToolError,
  MaxStepsError,
  AbortedError,
  GatewayError,
  WidgetError,
  HashlineError,
  PermissionError,
  ApprovalBrokerError,
  AuditError,
  PolicyConflictError,
  WorkerSchedulerError,
  UnsupportedBackendError,
  SkillStoreUnavailableError,
  SkillCollisionError,
  SkillBodyUnavailableError,
  SkillBodyRequiredError,
  PersistConfigInvalidError,
  SessionIdInvalidError,
  PrincipalRequiredError,
  TenancyWorkspaceRequiredError,
  CredentialRequiredError,
  type InferenceErrorCode,
  type InferenceErrorOptions,
} from "../../foundations/errors.js";

// Spec 022 Tenancy exports
export {
  resolveTenancyMode,
  validateTenancyCompleteness,
  emitTenancyNoticeOnce,
  emitCredentialsSingleUserWarningOnce,
  TenancyRuntimeRequiredError,
  TenancyStoreIncompleteError,
  TenancyAmbientIoError,
  type TenancyMode,
  type TenancySignals,
  type TenancyResolution,
} from "../../domain/tenancy/tenancy-mode.js";

// Re-export middleware pipeline
export {
  compose,
  type PipelineContext,
  type Middleware,
  loggingMiddleware,
  rateLimitMiddleware,
  authMiddleware,
} from "../../domain/index.js";

export { GatewaySettingsAdapter } from "../../capabilities/gateway/settings-adapter.js";
import type { GatewayConfig } from "../../capabilities/gateway/types.js";
import type { GatewaySettingsAdapter } from "../../capabilities/gateway/settings-adapter.js";
import {
  resolveTenancyMode,
  validateTenancyCompleteness,
  emitTenancyNoticeOnce,
  emitCredentialsSingleUserWarningOnce,
  type TenancyMode,
  type TenancySignals,
} from "../../domain/tenancy/tenancy-mode.js";
import { TenancyWorkspaceRequiredError } from "../../foundations/errors.js";

// Gateway (lazy — only loaded when used; Spec 022 returns { gateway, tools }, no global registration)
export const gateway = {
  async createGateway(
    config: GatewayConfig,
    settingsAdapter?: GatewaySettingsAdapter,
    options?: { tenancy?: TenancyMode },
  ) {
    const { createGateway } = await import('../../capabilities/gateway/index.js');
    const { GatewaySettingsAdapter: Adapter } = await import('../../capabilities/gateway/settings-adapter.js');
    const mode = options?.tenancy ?? config.tenancy;
    if (mode === "multi" && !settingsAdapter) {
      const { TenancyAmbientIoError } = await import('../../domain/tenancy/tenancy-mode.js');
      throw new TenancyAmbientIoError(
        path.join(homedir(), '.seepient'),
        'Ambient gateway adapter default at "~/.seepient" is forbidden in multi-tenant mode. Pass an explicit GatewaySettingsAdapter.',
      );
    }
    const storageDir = process.env.SEEPIENT_GATEWAY_DIR ?? path.join(homedir(), '.seepient');
    const adapter = settingsAdapter ?? new Adapter(storageDir);
    if (!settingsAdapter) await adapter.initialize();
    return createGateway(config, adapter);
  },
};

// Re-export all types
export type {
  Message,
  ToolCall,
  StepResult,
  Usage,
  CumulativeUsage,
  UserToolDefinition,
  ToolContext,
  ToolResult,
  Hooks,
  AskSeepientOptions,
  AskSeepientResult,
  AskSeepientStreamResult,
  AgentResponse,
  SessionData,
  PersistenceBackend,
  PersistenceConfig,
  SkillMetadata,
  ToolRiskCategory,
  Purpose,
  Tier,
} from "../../foundations/types.js";

function toCapabilitySet(cap: import("../../foundations/contracts/permission-policy.js").CapabilitySet | import("../../foundations/contracts/permission-policy.js").Capability[] | undefined): import("../../foundations/contracts/permission-policy.js").CapabilitySet | undefined {
  if (!cap) return undefined;
  if (Array.isArray(cap)) {
    return { version: 1, capabilities: cap };
  }
  return cap;
}

export {
  createPersistenceBackend,
  /**
   * @warning Profile A only. Modifies process-wide persistence backend registry.
   * In multi-tenant environments, pass instanced PersistenceBackend implementations directly.
   */
  registerBackend,
} from "../../domain/sessions/session-store.js";



// ── askSeepient ──────────────────────────────────────────────────────────

import { computeEffectiveSkillSources, emitMultiZeroSourcesNoticeOnce } from "./skill-sources-helper.js";

/**
 * Resolve the skill catalog for a one-shot SDK call. Returns the system prompt
 * with the catalog appended and the held SkillRegistry instance, or the prompt
 * unchanged when skills are disabled or none are found. Best-effort: discovery
 * failures are swallowed.
 */
async function resolveSkills(
  systemPrompt: string | undefined,
  skills: string[] | boolean | import("../../foundations/contracts/skill-source.js").SkillLiteral[] | undefined,
  cwd?: string,
  tenancyMode?: TenancyMode,
  sources?: import("../../foundations/contracts/skill-source.js").SkillSource[],
): Promise<{ systemPrompt: string | undefined; skillRegistry?: import("../../capabilities/skills/types.js").SkillRegistry }> {
  if (skills === false) return { systemPrompt };
  const effectiveSources = computeEffectiveSkillSources(sources, skills);
  if (tenancyMode === "multi" && effectiveSources.length === 0) {
    emitMultiZeroSourcesNoticeOnce();
    return { systemPrompt };
  }
  try {
    const skillRegistry = await initializeSkillRegistry(cwd ?? process.cwd(), { sources: effectiveSources, tenancyMode });
    let metadata = skillRegistry.getMetadata();
    const isLiteralList =
      Array.isArray(skills) &&
      skills.some(
        (s) => typeof s === "object" && s !== null && "content" in s,
      );
    if (Array.isArray(skills) && !isLiteralList) {
      const wanted = new Set(skills.filter((s): s is string => typeof s === "string"));
      const available = new Set(metadata.map((s) => s.name));
      const missing = Array.from(wanted).filter((name) => !available.has(name));
      if (missing.length > 0) {
        console.warn(`[SKILLS] Warning: Skill filter requested unavailable skill(s): ${missing.join(", ")}`);
      }
      metadata = metadata.filter((s) => wanted.has(s.name));
    }
    if (metadata.length === 0) return { systemPrompt, skillRegistry };
    const catalog = buildSkillCatalog(metadata);
    return {
      systemPrompt: systemPrompt ? systemPrompt + "\n\n" + catalog : catalog,
      skillRegistry,
    };
  } catch (err: any) {
    console.warn(`[SKILLS] Warning: Failed to resolve skills: ${err?.message ?? err}`);
    return { systemPrompt };
  }
}

/**
 * Unified one-shot execution entry point (stateless).
 *
 * Runs an agent loop for a single prompt-response completion with autonomous
 * tool execution loop up to a maximum step limit.
 *
 * When `options.stream` is `true`, returns an `AskSeepientStreamResult` with
 * async iterables (`textStream`, `steps`) and Web API SSE helpers (`toResponse()`, `toSSEStream()`).
 *
 * When `options.stream` is falsy or omitted, returns an `AskSeepientResult`.
 *
 * @example
 * ```ts
 * // Non-streaming one-shot
 * const result = await askSeepient("What is the weather in SF?", {
 *   tools: ["web_search"],
 *   maxSteps: 5,
 * });
 * console.log(result.text);
 *
 * // Streaming one-shot
 * const stream = await askSeepient("Explain quantum computing", {
 *   stream: true,
 *   onText: (delta) => process.stdout.write(delta),
 * });
 * for await (const chunk of stream.textStream) { ... }
 * ```
 */
export async function askSeepient(
  prompt: string,
  options: AskSeepientOptions & { stream: true },
): Promise<AskSeepientStreamResult>;
export async function askSeepient(
  prompt: string,
  options?: AskSeepientOptions & { stream?: false },
): Promise<AskSeepientResult>;
export async function askSeepient(
  prompt: string,
  options?: AskSeepientOptions,
): Promise<AskSeepientResult | AskSeepientStreamResult>;
export async function askSeepient(
  prompt: string,
  options?: AskSeepientOptions,
): Promise<AskSeepientResult | AskSeepientStreamResult> {
  const opts = options ?? {};
  if (opts.sessionId !== undefined) {
    validateSessionId(opts.sessionId);
  }
  const effectiveSources = computeEffectiveSkillSources(opts.sources, opts.skills);

  const hasInjectedCredentials = Boolean(
    ((opts as any).credentials && Object.keys((opts as any).credentials).length > 0) ||
    ((opts as any).providers && (Array.isArray((opts as any).providers) ? (opts as any).providers.length > 0 : Object.keys((opts as any).providers).length > 0)),
  );

  const tenancySignals: TenancySignals = {
    explicit: opts.tenancy,
    principalIdSet: Boolean(opts.principalId && opts.principalId !== "default" && opts.principalId !== "sdk-user"),
    anyStoreInjected: Boolean(opts.auditStore || opts.policyStore || opts.capabilityLedger),
    runtimeInjected: Boolean(opts.runtime),
    persistInjected: false,
    skillSourcesInjected: Boolean(opts.sources && opts.sources.length > 0),
    credentialsInjected: hasInjectedCredentials,
  };
  const { mode: tenancyMode, upgraded } = resolveTenancyMode(tenancySignals);
  emitTenancyNoticeOnce(upgraded);

  // Validate tenancy completeness before any runtime defaulting or I/O
  validateTenancyCompleteness(tenancyMode, {
    runtime: opts.runtime,
    auditStore: opts.auditStore,
    policyStore: opts.policyStore,
    capabilityLedger: opts.capabilityLedger,
    stateless: opts.stateless,
    isSessionful: false,
    principalId: opts.principalId,
  });

  if (tenancyMode === "multi" && (!opts.cwd || typeof opts.cwd !== "string" || opts.cwd.trim().length === 0)) {
    throw new TenancyWorkspaceRequiredError();
  }

  const maxSteps = opts.maxSteps ?? 10;
  const runtime = opts.runtime ?? createAmbientProviderRuntime();

  // One abort controller per call: bridges the caller's signal and drives the
  // agent loop AND media vendor operations in both modes, so `stream.abort()`
  // stops every in-flight media fetch (W110).
  const abortController = new AbortController();
  // B2: the bridge listener is removed when the call completes — a {once}
  // listener never fired stays attached to the caller's long-lived signal
  // and accumulates one listener per askSeepient call.
  let detachSignalBridge: (() => void) | undefined;
  if (opts.signal) {
    if (opts.signal.aborted) {
      abortController.abort(opts.signal.reason);
    } else {
      const bridgeAbort = () => abortController.abort(opts.signal?.reason);
      opts.signal.addEventListener("abort", bridgeAbort, { once: true });
      detachSignalBridge = () => {
        opts.signal?.removeEventListener("abort", bridgeAbort);
      };
    }
  }

  // Resolve skill catalog and append to the system prompt
  const { systemPrompt, skillRegistry } = await resolveSkills(
    opts.systemPrompt,
    opts.skills,
    opts.cwd,
    tenancyMode,
    opts.sources,
  );

  // Construct per-call ToolRegistry (Spec 022)
  const toolRegistry = new ToolRegistry();
  for (const item of opts.tools ?? []) {
    if (
      item &&
      typeof item === "object" &&
      "definition" in item &&
      typeof (item as { definition?: any }).definition?.function?.name === "string" &&
      typeof (item as { handler?: any }).handler === "function" &&
      !("trust" in item)
    ) {
      toolRegistry.register(item as unknown as ToolModule);
    }
  }

  // Resolve tools
  const toolDefs = opts.tools ? resolveTools(opts.tools, toolRegistry) : toolRegistry.definitions();
  // spec 019 FR-006: explicit trustedHostTool registrations wire into the
  // boundary's host-callback map and join the operator allowlist.
  const { callbacks: hostCallbacks, registrationIds } = extractHostCallbacks(opts.tools, {
    skills: skillRegistry,
    registry: toolRegistry,
  });
  // spec 020 FR-001: custom preparedTool and brokerConnector registrations
  const registrations = extractRegistrations(opts.tools);

  // Build message list
  const messages: Message[] = [];
  messages.push({
    id: generateId(),
    role: "user" as const,
    content: prompt,
    timestamp: now(),
  });

  const { buildActionLifecycle } = await import("../../domain/permissions/action-lifecycle-factory.js");
  const { legacyApproveToolToBroker } = await import("../legacy-adapter.js");
  const { buildLocalBoundary } = await import("../../capabilities/execution/build-local-boundary.js");
  const { createSnapshotStore } = await import("../../foundations/hashline/snapshot-store.js");
  const { InMemoryArtifactStore } = await import("../../capabilities/execution/in-memory-artifact-store.js");
  const { createMediaVendorOperationHandler } = await import("../../domain/media/vendor-operation-handler.js");
  const snapshotStore = createSnapshotStore();
  const sharedArtifacts = new InMemoryArtifactStore();
  const vendorOperationHandler = createMediaVendorOperationHandler({
    runtime,
    artifacts: sharedArtifacts,
    signal: abortController.signal,
    tenancyMode,
  });
  const secretResolver =
    tenancyMode === "multi"
      ? (ref: string) => {
          const store = (runtime as any).credentialStore ?? (runtime as any).getCredentialStore?.();
          return store?.resolveSecret?.(ref) ?? undefined;
        }
      : undefined;
  const { boundary } = await buildLocalBoundary({
    artifacts: sharedArtifacts,
    workspaceRoot: opts.cwd ?? process.cwd(),
    snapshotStore,
    hostCallbacks,
    vendorOperationHandler,
    commitHelper: opts.commitHelper,
    network: opts.network,
    tenancyMode,
    secretResolver,
  });
  const approvalMode = opts.consentMode
    ? (opts.consentMode === "autonomous" ? "autonomous" : opts.consentMode === "ask-everything" ? "manual" : "balanced")
    : (opts.approvalBroker || opts.approveTool ? "manual" : "never");

  const wiredPipeline = await buildActionLifecycle({
    principalId: opts.principalId ?? "sdk-user",
    runId: generateId(),
    workspaceRoot: opts.cwd ?? process.cwd(),
    modelProviderClass: (opts.provider ?? "openai") as string,
    approvalBroker: opts.approvalBroker ?? legacyApproveToolToBroker(opts.approveTool),
    executionBoundary: boundary,
    approvalMode,
    deploymentCeiling: toCapabilitySet(opts.deploymentCeiling),
    principalPolicy: toCapabilitySet(opts.principalPolicy),
    artifacts: sharedArtifacts,
    snapshotStore,
    trustedHostAllowlist: [...DEFAULT_TRUSTED_HOST_ALLOWLIST, ...registrationIds],
    registrations,
    auditStore: opts.auditStore,
    policyStore: opts.policyStore,
    capabilityLedger: opts.capabilityLedger,
    operatorBaseline: toCapabilitySet(opts.operatorBaseline),
    tenancyMode,
  });

  if (opts.stream) {
    // Hooks — merge stream-level callbacks with any base hooks
    const mergedHooks = { ...opts.hooks };
    const hooks = createHookExecutor(mergedHooks);

    // Stream manager handles queues, async iterables, and SSE
    const stream = new StreamManager();

    (async () => {
      try {
        const snapshot = await runtime.createTurnSnapshot();

        const result = await runAgentLoop({
          runtime,
          turnSnapshot: snapshot,
          model: opts.model,
          modelOverride: opts.providerAccount || opts.model
            ? { providerAccount: opts.providerAccount, model: opts.model }
            : undefined,
          purpose: opts.purpose,
          tier: opts.tier,
          temperature: opts.temperature,
          maxTokens: opts.maxTokens,
          messages,
          toolRegistry,
          toolDefs,
          systemPrompt,
          maxSteps,
          hooks,
          tenancyMode,
          signal: abortController.signal,
          config: { ...opts.config, runtime, skills: skillRegistry },
          metadata: opts.metadata,
          middleware: opts.middleware,
          approveTool: opts.approveTool,
          wiredPipeline,
          onStep: (step: StepResult) => {
            if (opts.onStep) opts.onStep(step);
            if (
              (step.type === "text" || step.type === "text_delta") &&
              step.content
            ) {
              if (opts.onText) opts.onText(step.content);
              stream.enqueueText(step.content);
            }
            if (step.type === "tool_call" && step.toolCall) {
              if (opts.onToolCall) {
                opts.onToolCall({
                  name: step.toolCall.name,
                  args: step.toolCall.args,
                  callId: step.toolCall.id,
                });
              }
              if (opts.onToolResult) {
                const output = step.toolCall.result;
                const success =
                  typeof output === "string"
                    ? !output.startsWith("Error:")
                    : true;
                opts.onToolResult({
                  callId: step.toolCall.id,
                  output,
                  success,
                });
              }
            }
            stream.enqueueStep(step);
          },
        });

        const lastAssistant = [...result.messages]
          .reverse()
          .find((m) => m.role === "assistant" && m.content);
        const textFromSteps = result.steps
          .filter((s: StepResult) => s.type === "text" || s.type === "text_delta")
          .map((s: StepResult) => s.content ?? "")
          .join("");
        const allText = textFromSteps || (lastAssistant?.content ?? "");

        const loopErr = extractLoopError(result);
        stream.resolveUsage(result.usage);
        if (loopErr) {
          if (opts.onError) opts.onError(loopErr);
          stream.resolveFinish("error");
          // F2: a failed turn must be observable — fullText rejects, in
          // parity with the non-streaming throw.
          stream.rejectText(loopErr);
        } else {
          stream.resolveText(allText);
          stream.resolveFinish(result.finishReason);
          // W112: fire hooks.onFinish in streaming mode too, with the same
          // assembled result the non-streaming path would have returned.
          const streamedResult: AskSeepientResult = {
            text: allText,
            steps: result.steps,
            toolCalls: result.toolCalls,
            usage: result.usage,
            finishReason: result.finishReason as AskSeepientResult["finishReason"],
            messages: result.messages,
          };
          await hooks.onFinish(streamedResult);
        }
      } catch (err) {
        const seepientErr = toSeepientError(err, "PROVIDER_ERROR");
        if (opts.onError) opts.onError(seepientErr);
        // F2: reject fullText instead of resolving "" — silent empty
        // responses hid provider failures from callers without onError.
        stream.rejectText(seepientErr);
        stream.resolveUsage({ promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 });
        stream.resolveFinish("error");
      } finally {
        detachSignalBridge?.();
        stream.complete();
      }
    })();

    return {
      textStream: stream.textStream,
      steps: stream.stepsStream,
      fullText: stream.fullText,
      usage: stream.usage,
      finishReason: stream.finishReason,
      abort: () => abortController.abort(),
      toResponse: (respOpts?: { headers?: Record<string, string> }) => stream.toResponse(respOpts),
      toSSEStream: () => stream.toSSEStream(),
    };
  }

  // Non-streaming (default)
  const hooks = createHookExecutor(opts.hooks);
  const snapshot = await runtime.createTurnSnapshot();

  const result = await runAgentLoop({
    runtime,
    turnSnapshot: snapshot,
    model: opts.model,
    modelOverride: opts.providerAccount || opts.model
      ? { providerAccount: opts.providerAccount, model: opts.model }
      : undefined,
    purpose: opts.purpose,
    tier: opts.tier,
    temperature: opts.temperature,
    maxTokens: opts.maxTokens,
    messages,
    toolRegistry,
    toolDefs,
    systemPrompt,
    maxSteps,
    hooks,
    signal: abortController.signal,
    config: { ...opts.config, runtime, skills: skillRegistry },
    metadata: opts.metadata,
    middleware: opts.middleware,
    approveTool: opts.approveTool,
    wiredPipeline,
    tenancyMode,
    onStep: opts.onStep || opts.onText || opts.onToolCall || opts.onToolResult ? (step: StepResult) => {
      if (opts.onStep) opts.onStep(step);
      if ((step.type === "text" || step.type === "text_delta") && step.content) {
        if (opts.onText) opts.onText(step.content);
      }
      if (step.type === "tool_call" && step.toolCall) {
        if (opts.onToolCall) {
          opts.onToolCall({
            name: step.toolCall.name,
            args: step.toolCall.args,
            callId: step.toolCall.id,
          });
        }
        if (opts.onToolResult) {
          const output = step.toolCall.result;
          const success =
            typeof output === "string"
              ? !output.startsWith("Error:")
              : true;
          opts.onToolResult({
            callId: step.toolCall.id,
            output,
            success,
          });
        }
      }
    } : undefined,
  });

  detachSignalBridge?.();

  // W111: onError parity with the streaming branch — report before rejecting.
  const loopError = extractLoopError(result);
  if (loopError) {
    if (opts.onError) opts.onError(loopError);
    throw loopError;
  }

  const lastAssistant = [...result.messages]
    .reverse()
    .find((m) => m.role === "assistant" && m.content);
  const text = lastAssistant?.content ?? "";

  const askResult: AskSeepientResult = {
    text,
    steps: result.steps,
    toolCalls: result.toolCalls,
    usage: result.usage,
    finishReason: result.finishReason as AskSeepientResult["finishReason"],
    messages: result.messages,
  };

  await hooks.onFinish(askResult);
  return askResult;
}
