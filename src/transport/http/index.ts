/**
 * Seepient Remote Server — Entry Point
 *
 * Creates an HTTP server with REST endpoints and WebSocket support
 * for real-time streaming conversations with LLM providers.
 *
 * Default port: 7337
 */

import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "node:crypto";
import { homedir } from "os";

import { getSyncBuiltinCatalog } from "../../domain/providers/model-catalog.js";
import { createIsolatedProviderRuntime } from "../../domain/providers/provider-runtime.js";
import { serverGenerateText, serverStreamText } from "./server-core.js";
import { createRestHandler, type RestHandlerContext } from "./rest.js";
import { setupWebSocket, type WebSocketHandlerContext } from "../ws/websocket.js";
import { createConnectionRegistry } from "../ws/connection-registry.js";
import { ServerSessionManager } from "./session-store.js";
import { MemoryPersistenceBackend } from "../../domain/sessions/session-store.js";
import { SettingsManager } from "../../domain/settings/settings-manager.js";
import { ToolRegistry } from "../../domain/tool-executor.js";
import type { SettingsHandlerContext } from "./settings-handlers.js";
import type { WsServerHandle } from "../ws/websocket.js";
import { loadMergedConfig, getConfigPaths, loadJsonConfig } from "../../foundations/config.js";
import { RateLimiter, globalRateLimiter } from "./rate-limit.js";
import { logTransportEvent } from "../logging.js";

// ── Types ──────────────────────────────────────────────────────────────

import type { RunSeepientServerOptions } from "../../foundations/types.js";
export type { RunSeepientServerOptions };

export {
  generateApiKey,
  validateApiKey,
  revokeApiKey,
  listApiKeys,
  type KeyScope,
  type ApiKeyEntry,
} from "../auth/auth.js";

interface ReadPackageJson {
  version: string;
}

/**
 * The `http.Server` returned by `runSeepientServer`, extended with a
 * `dispose()` handle that un-registers the server's process signal handlers
 * (registered only when the server listens) — W130 embedding contract.
 */
export type SeepientHttpServer = http.Server & {
  dispose: () => void;
  server?: http.Server;
  runtime?: any;
  getRuntime?: () => any;
};

// ── Helpers ────────────────────────────────────────────────────────────

function resolveVersion(): string {
  try {
    // Try relative to dist/ first (production), then src/ (development)
    const pkgPath = path.join(import.meta.dirname ?? ".", "..", "..", "package.json");
    const raw = fs.readFileSync(pkgPath, "utf-8");
    return (JSON.parse(raw) as ReadPackageJson).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function resolvePort(options?: RunSeepientServerOptions): number {
  if (options?.port !== undefined) return options.port;
  const fromEnv = parseInt(process.env.SEEPIENT_PORT ?? process.env.PORT ?? "", 10);
  if (!isNaN(fromEnv) && fromEnv > 0) return fromEnv;
  return 7337;
}

// ── Model listing ──────────────────────────────────────────────────────
 
function listModels(): Record<string, string[]> {
  const models = getSyncBuiltinCatalog();
  const result: Record<string, string[]> = {};
  for (const m of models) {
    const p = m.upstreamProvider || "default";
    if (!result[p]) {
      result[p] = [];
    }
    result[p].push(m.id);
  }
  return result;
}

/**
 * Initialize the skill registry.
 * Called once during server startup to verify skills system.
 */
export async function initializeSkills(): Promise<void> {
  try {
    const { initializeSkillRegistry } = await import("../../capabilities/skills/index.js");
    await initializeSkillRegistry(process.cwd());
  } catch {
    // Skills system not available
  }
}

async function listSkills(sources?: import("../../foundations/contracts/skill-source.js").SkillSource[]): Promise<{ name: string; description: string; tags: string[] }[]> {
  try {
    const { initializeSkillRegistry } = await import("../../capabilities/skills/index.js");
    const registry = await initializeSkillRegistry(process.cwd(), {
      tenancyMode: "multi",
      sources: sources ?? [],
    });
    return registry.getMetadata().map((s) => ({
      name: s.name,
      description: s.description,
      tags: s.tags,
    }));
  } catch {
    return [];
  }
}

// ── CORS helper ────────────────────────────────────────────────────────

function appendVaryOrigin(res: http.ServerResponse): void {
  const current = res.getHeader("Vary");
  if (!current) {
    res.setHeader("Vary", "Origin");
  } else {
    const parts = String(current).split(",").map((s) => s.trim());
    if (!parts.includes("Origin")) {
      res.setHeader("Vary", `${current}, Origin`);
    }
  }
}

function getCorsAllowlist(corsOriginsSetting?: string | null): string[] | null {
  const envVal = process.env.SEEPIENT_CORS_ORIGINS !== undefined
    ? process.env.SEEPIENT_CORS_ORIGINS
    : (corsOriginsSetting ?? null);
  if (!envVal) return null;
  return envVal.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function addCORSHeaders(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  corsOriginsSetting?: string | null,
): void {
  const allowlist = getCorsAllowlist(corsOriginsSetting);
  const origin = req.headers.origin;

  if (allowlist !== null) {
    if (allowlist.includes("*")) {
      res.setHeader("Access-Control-Allow-Origin", origin ?? "*");
      if (origin) {
        appendVaryOrigin(res);
      }
    } else if (origin && allowlist.includes(origin.toLowerCase())) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      appendVaryOrigin(res);
    }
  } else {
    // W145: no allowlist configured — reflect nothing. Cross-origin browser
    // access must be opted into via `server.corsOrigins` (or
    // SEEPIENT_CORS_ORIGINS, "*" to reflect any origin). The previous
    // default silently mirrored any Origin header, making the allowlist
    // feature moot out of the box.
  }

  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Seepient-API-Key");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function isPreflight(req: http.IncomingMessage): boolean {
  return req.method === "OPTIONS";
}

function handlePreflight(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  res.writeHead(204);
  res.end();
}

// ── Server creation ────────────────────────────────────────────────────

/**
 * Create and return the Seepient HTTP server (not yet listening).
 *
 * This sets up REST endpoints, WebSocket upgrade handling,
 * session management, and CORS support.
 */
export async function runSeepientServer(options?: RunSeepientServerOptions): Promise<SeepientHttpServer> {
  const version = resolveVersion();
  const startTime = Date.now();
  const serverToolRegistry = options?.toolRegistry ?? (options?.builtInTools ? new ToolRegistry() : new ToolRegistry([]));

  // Spec 008: build a per-request pipeline factory when the operator opts in.
  // Product behavior: each API request gets its OWN permission identity
  // (principal, tenant, session, run). Sharing one pipeline across requests
  // would let one user's authority or audit trail leak into another's.
  //
  // The factory creates a fresh WiredActionLifecycle per call with the
  // authenticated principal's identity. The execution boundary is per-request
  // too, so workspace leases and broker leases are isolated.
  type PipelineFactory = (identity: {
    principalId: string;
    tenantId: string;
    sessionId: string;
    runId: string;
    workspaceRoot: string;
    modelProviderClass: string;
  }) => Promise<import("../../domain/permissions/action-lifecycle-factory.js").WiredActionLifecycle>;
  let outboxFlushTimer: NodeJS.Timeout | undefined;
  let serverOutboxRef: import("../../domain/permissions/audit-recorder.js").TerminalEventOutbox | undefined;
  let serverPipelineFactory: PipelineFactory | undefined;
  const serverPermissionPipelineEnabled = true;
  // FROZEN SCOPE (R9.1): the server control plane does NOT execute model-
  // authored effects. Per the release scope, multi-tenant server/container
  // execution is DISABLED until the external scheduler is complete; the
  // process holding provider credentials must not execute model-authored
  // shell commands (FR-017/FR-018, ARCHITECTURE.md). There is intentionally NO
  // in-process fallback: a localhost bind or a fallback flag cannot make this
  // safe, because a loopback server can sit behind a reverse proxy and serve
  // multiple users. Every effectful operation through the server therefore
  // returns `backend-unsupported` and is denied before dispatch. Local CLI /
  // TUI / SDK execution is unaffected — those roots wire the real local
  // boundary directly, not through the server.
  if (process.env.SEEPIENT_ALLOW_LOCAL_FALLBACK === "1" || process.env.SEEPIENT_WORKER_SCHEDULER === "1" || process.env.SEEPIENT_WORKER_SCHEDULER_ENDPOINT) {
    throw new Error(
      "Server-side effect execution is disabled in this release. The HTTP server " +
        "never runs model-authored effects in the control plane — a real external " +
        "Docker worker scheduler (separate process, mTLS) is required and is not " +
        "yet implemented. Unset SEEPIENT_ALLOW_LOCAL_FALLBACK / " +
        "SEEPIENT_WORKER_SCHEDULER to start the server in effect-free mode, or use " +
        "the local CLI/SDK for tool execution.",
    );
  }
  let serverRuntime: any;
  if (options?.runtime) {
    const runtimeAny = options.runtime as any;
    if (
      runtimeAny.isIsolated !== true ||
      (runtimeAny.configStore && runtimeAny.configStore.isIsolated !== true) ||
      (runtimeAny.credentialStore && runtimeAny.credentialStore.isIsolated !== true)
    ) {
      const { TenancyRuntimeRequiredError } = await import("../../domain/tenancy/tenancy-mode.js");
      throw new TenancyRuntimeRequiredError();
    }
    serverRuntime = options.runtime;
  } else {
    process.stderr.write("[seepient] Notice: server booted with isolated empty ProviderRuntime.\n");
    serverRuntime = createIsolatedProviderRuntime();
  }
  const getServerRuntime = () => serverRuntime;

  if (serverPermissionPipelineEnabled) {
    const { buildActionLifecycle } = await import("../../domain/permissions/action-lifecycle-factory.js");
    const { NoneApprovalBroker } = await import("../approval-brokers.js");
    const { TerminalEventOutbox, recoverIndeterminateActions } = await import("../../domain/permissions/audit-recorder.js");
    const { isLocalAuditStore } = await import("../../foundations/contracts/execution-brokers.js");
    const { InMemoryAuditStore, InMemoryPolicyStore, InMemoryCapabilityLedger } = await import("../../domain/permissions/in-memory-stores.js");

    if (
      (options?.auditStore && (options.auditStore as any).isIsolated !== true) ||
      (options?.policyStore && (options.policyStore as any).isIsolated !== true) ||
      (options?.capabilityLedger && (options.capabilityLedger as any).isIsolated !== true)
    ) {
      const { TenancyStoreIncompleteError } = await import("../../domain/tenancy/tenancy-mode.js");
      throw new TenancyStoreIncompleteError(
        [],
        'Multi-tenant mode requires isolated stores (isIsolated: true). Ambient stores cannot be used in multi-tenant mode.',
      );
    }

    const serverAuditStore = options?.auditStore ?? new InMemoryAuditStore();
    const isLocalStore = isLocalAuditStore(serverAuditStore);

    const serverPolicyStore = options?.policyStore ?? new InMemoryPolicyStore();
    const serverCapabilityLedger = options?.capabilityLedger ?? new InMemoryCapabilityLedger();
    // The outbox MUST be backed by the SAME LocalAuditStore the per-request
    // lifecycles use, otherwise the flush timer + recovery operate on a
    // different pending-event set than the one live requests populate.
    const serverOutbox = isLocalStore
      ? new TerminalEventOutbox(
          serverAuditStore as import("../../domain/permissions/audit-recorder.js").LocalAuditStore,
          (serverAuditStore as any).dir ? { outboxDir: path.join((serverAuditStore as any).dir, "outbox") } : undefined,
        )
      : undefined;
    serverOutboxRef = serverOutbox;

    // The periodic flush timer MUST start regardless of whether the one-time
    // recovery (reload/flush/recover) succeeds — a recovery failure must not
    // leave the server running with no drain path. Create it outside the try.
    if (serverOutbox) {
      try {
        await serverOutbox.reload();
        await serverOutbox.flush();
        await recoverIndeterminateActions(serverAuditStore as import("../../domain/permissions/audit-recorder.js").LocalAuditStore, serverOutbox);
      } catch (e) {
        console.warn("[server] Audit outbox recovery initialization failed:", e instanceof Error ? e.message : String(e));
      }
      outboxFlushTimer = setInterval(() => {
        serverOutbox.flush().catch(() => {});
      }, 10_000);
      outboxFlushTimer.unref();
    }

    // A fail-closed boundary: no operation kind is supported, so policy denies
    // every effectful action with `backend-unsupported` before dispatch. The
    // server remains useful for chat/planning/effect-free tools; it never
    // performs a model-authored side effect.
    const unsupportedBoundary: import("../../foundations/contracts/execution-boundary.js").ExecutionBoundary = {
      capabilities: {
        backend: "uncontained",
        capabilityKinds: [],
        exactCommit: false,
        hostFilteredEgress: false,
        environmentIsolation: false,
        supportedOperationKinds: [],
      },
      async execute() {
        return {
          state: "failed" as const,
          error: {
            code: "BACKEND_UNSUPPORTED",
            message: "Tool operations (including file reads) are not supported on the server surface until the Docker worker backend ships (spec 008). Chat and model inference are unaffected.",
            retryable: false,
          },
          evidence: {
            backend: "uncontained" as const,
            actionDigest: "",
            executorId: "server-unsupported",
            operationKind: "none" as const,
          },
        };
      },
    };

    const serverOperatorBaseline: import("../../foundations/contracts/permission-policy.js").CapabilitySet | undefined = options?.operatorBaseline
      ? (Array.isArray(options.operatorBaseline)
          ? { version: 1 as const, capabilities: options.operatorBaseline }
          : options.operatorBaseline)
      : undefined;

    serverPipelineFactory = async (identity) => {
      return buildActionLifecycle({
        principalId: identity.principalId,
        runId: identity.runId,
        workspaceRoot: identity.workspaceRoot,
        modelProviderClass: identity.modelProviderClass,
        approvalBroker: new NoneApprovalBroker(),
        executionBoundary: unsupportedBoundary,
        approvalMode: "never",
        auditStore: serverAuditStore,
        policyStore: serverPolicyStore,
        capabilityLedger: serverCapabilityLedger,
        terminalOutbox: serverOutbox,
        tenancyMode: "multi",
        operatorBaseline: serverOperatorBaseline,
      });
    };
  }

  // Resolve session persistence: in multi-tenant server mode, default to in-memory
  // unless an explicit persist backend or SEEPIENT_SESSION_DIR is provided (P1-7.1 / Rule 9.2).
  const sessionDir = process.env.SEEPIENT_SESSION_DIR;
  const sessionTTL = (options?.sessionTTL ?? parseInt(process.env.SEEPIENT_SESSION_TTL ?? "86400", 10)) * 1000;

  // Create session manager
  const sessionManager = new ServerSessionManager({
    sessionDir,
    sessionTTL,
    backend: options?.persist ?? (sessionDir ? undefined : new MemoryPersistenceBackend()),
  });
  sessionManager.startCleanup();

  // Create settings handler context (shared by REST and WS)
  let settingsManager = options?.settingsManager;
  if (!settingsManager) {
    // NEW-1: In multi-tenant mode, do NOT read ambient host operator dotfiles (~/.seepient/setting.json)
    // or host environment variables into tenant settings context. Use an isolated in-memory SettingsManager.
    const serverConfig: Record<string, any> = {
      server: {
        ...(process.env.SEEPIENT_CORS_ORIGINS ? { corsOrigins: process.env.SEEPIENT_CORS_ORIGINS } : {}),
        ...(process.env.SEEPIENT_MAX_BODY_BYTES ? { maxBodyBytes: parseInt(process.env.SEEPIENT_MAX_BODY_BYTES, 10) } : {}),
        ...(process.env.SEEPIENT_RATE_LIMIT_RPM ? { rateLimitRpm: parseInt(process.env.SEEPIENT_RATE_LIMIT_RPM, 10) } : {}),
      },
    };
    settingsManager = new SettingsManager({
      config: serverConfig,
      projectConfigPath: undefined,
      globalConfigPath: undefined,
      projectConfig: {},
      globalConfig: {},
      isIsolated: true,
    });
  }
  // W131: per-instance WS registries — never module-global
  const wsRegistry = createConnectionRegistry({ inMemory: true });
  // Wire registered server settings: env override -> settings value -> default
  const corsOriginsSetting = settingsManager.get("server.corsOrigins").value as string | undefined;
  const maxBodyBytesSetting = settingsManager.get("server.maxBodyBytes").value as number | undefined;
  const rateLimitRpmSetting = settingsManager.get("server.rateLimitRpm").value as number | undefined;

  const settingsHandlerContext: SettingsHandlerContext = {
    settingsManager,
    getOtherClients: (excludeWs) => wsRegistry.getOtherClients(excludeWs),
    maxBodyBytes: maxBodyBytesSetting,
    runtime: getServerRuntime(),
    tenancyMode: "multi",
  };

  // W161: re-read server.rateLimitRpm per consume — a settings PATCH takes
  // effect on the next request instead of silently requiring a restart.
  const serverRateLimiter = new RateLimiter(
    rateLimitRpmSetting ?? 300,
    () => settingsManager.get("server.rateLimitRpm").value as number | undefined,
  );
  globalRateLimiter.setDefaultRpm(rateLimitRpmSetting ?? 300);

  // Initialize gateway (FR-017 / FR-010: default-off in multi-tenant server boot; requires explicit opt-in with isolated storageDir)
  let gatewayHandler: ((req: any, res: any, path: string, method: string) => Promise<void>) | undefined;
  let gatewayMiddleware: import("../../foundations/contracts/middleware.js").Middleware[] | undefined;
  const explicitGateway = options?.gateway;
  const isGatewayOptedIn = Boolean(
    explicitGateway === true ||
    (typeof explicitGateway === "object" && explicitGateway !== null && explicitGateway.enabled !== false)
  );

  if (isGatewayOptedIn) {
    const gwOpts = typeof explicitGateway === "object" && explicitGateway !== null ? explicitGateway : {};
    const ambientHomeSeepient = path.resolve(path.join(homedir(), ".seepient"));
    const explicitDir = gwOpts.storageDir ? path.resolve(gwOpts.storageDir) : undefined;
    if (!explicitDir || explicitDir === ambientHomeSeepient) {
      const { SeepientError } = await import("../../foundations/errors.js");
      throw new SeepientError(
        "GATEWAY_ISOLATION_REQUIRED: Gateway opt-in on a multi-tenant server requires an explicit isolated storageDir. Ambient ~/.seepient or ambient environment storage is not permitted.",
        "GATEWAY_ISOLATION_REQUIRED",
        false,
      );
    }
  }

  try {
    if (isGatewayOptedIn) {
      const gwOpts = typeof explicitGateway === "object" && explicitGateway !== null ? explicitGateway : {};
      const gatewayConfig = {
        enabled: true,
        semanticTopK: (gwOpts.semanticTopK ?? settingsManager.get("gateway.semanticTopK").value) as number,
        defaultRateLimitPerMin: (gwOpts.defaultRateLimitPerMin ?? settingsManager.get("gateway.defaultRateLimitPerMin").value) as number,
        maxAuditLogsInMemory: (gwOpts.maxAuditLogsInMemory ?? settingsManager.get("gateway.maxAuditLogs").value) as number,
      };

      const { GatewaySettingsAdapter } = await import("../../capabilities/gateway/settings-adapter.js");
      const gatewayStorageDir = gwOpts.storageDir!;
      const gwSettingsAdapter = new GatewaySettingsAdapter(gatewayStorageDir);
      await gwSettingsAdapter.initialize();

      // Use createGateway factory — proxy tools are registered into serverToolRegistry here (composition root, Spec 022)
      const { createGateway } = await import("../../capabilities/gateway/index.js");
      const gwResult = await createGateway(gatewayConfig, gwSettingsAdapter);

      if (gwResult) {
        const gatewayInstance = gwResult.gateway;
        serverToolRegistry.registerMany(gwResult.tools);
        const { createGatewayRestHandler } = await import("./rest-gateway.js");
        const { importOpenApiSpec } = await import("../../capabilities/gateway/openapi-importer.js");
        gatewayHandler = createGatewayRestHandler({ gateway: gatewayInstance, settingsAdapter: gwSettingsAdapter, importOpenApiSpec, maxBodyBytes: maxBodyBytesSetting, apiKeysFile: options?.apiKeysFile });

        // Wire semantic injection middleware
        const { semanticToolInjectionMiddleware } = await import("../../domain/middleware/semantic-tools.js");
        gatewayMiddleware = [semanticToolInjectionMiddleware(gatewayInstance, gatewayConfig.semanticTopK)];
      }
    }
  } catch (e: any) {
    if (e?.code === "GATEWAY_ISOLATION_REQUIRED") {
      throw e;
    }
    console.error("[server] Gateway initialization failed:", e instanceof Error ? e.message : String(e));
  }

  // Create REST handler context
  const restCtx: RestHandlerContext = {
    version,
    startTime,
    sessionManager,
    runtime: getServerRuntime(),
    generateText: async (opts) => {
      // Spec 008: construct a per-request pipeline with the authenticated
      // principal's identity. No shared state between requests.
      const principal = opts.principalId ?? opts.apiKeyHash;
      const { SENTINEL_PRINCIPAL_IDS, PrincipalRequiredError } = await import("../../domain/tenancy/tenancy-mode.js");
      if (!principal || typeof principal !== "string" || principal.trim().length === 0 || SENTINEL_PRINCIPAL_IDS.has(principal.trim())) {
        throw new PrincipalRequiredError();
      }
      let wiredPipeline: import("../../domain/permissions/action-lifecycle-factory.js").WiredActionLifecycle | undefined;
      if (serverPipelineFactory) {
        wiredPipeline = await serverPipelineFactory({
          principalId: principal.trim(),
          tenantId: opts.tenantId ?? "default",
          sessionId: opts.sessionId ?? crypto.randomUUID(),
          runId: crypto.randomUUID(),
          workspaceRoot: path.join(process.cwd(), ".seepient", "workspaces", principal.trim()),
          modelProviderClass: (opts.provider ?? "openai") as string,
        });
      }
      return serverGenerateText({ ...opts, sources: options?.sources, runtime: getServerRuntime(), wiredPipeline, toolRegistry: serverToolRegistry, tenancyMode: "multi", builtInTools: options?.builtInTools }, gatewayMiddleware);
    },
    listModels,
    listSkills: () => listSkills(options?.sources),
    settingsHandlerContext,
    gatewayHandler,
    maxBodyBytes: maxBodyBytesSetting,
    rateLimiter: serverRateLimiter,
    apiKeysFile: options?.apiKeysFile,
  };

  const restHandler = createRestHandler(restCtx);

  // Create HTTP server
  const enableCors = options?.cors ?? true;

  const server = http.createServer((req, res) => {
    // CORS
    if (enableCors) {
      addCORSHeaders(req, res, corsOriginsSetting);
    }

    // Preflight
    if (isPreflight(req)) {
      handlePreflight(req, res);
      return;
    }

    // Delegate to REST handler
    void Promise.resolve(restHandler(req, res)).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      logTransportEvent({
        level: "error",
        event: "http_request",
        requestId: crypto.randomUUID(),
        status: 500,
        error: message,
      });
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({
          error: {
            code: "INTERNAL_ERROR",
            message: "Internal server error",
          },
        }));
      }
    });
  });

  // Create WebSocket handler context
  const wsCtx: WebSocketHandlerContext = {
    registry: wsRegistry,
    rateLimiter: serverRateLimiter,
    sessionManager,
    streamText: async (opts) => {
      // Spec 008: construct a per-request pipeline with the WS client's
      // authenticated identity. No shared state between connections.
      const principal = opts.principalId ?? opts.apiKeyHash;
      const { SENTINEL_PRINCIPAL_IDS, PrincipalRequiredError } = await import("../../domain/tenancy/tenancy-mode.js");
      if (!principal || typeof principal !== "string" || principal.trim().length === 0 || SENTINEL_PRINCIPAL_IDS.has(principal.trim())) {
        opts.onError({
          code: "PRINCIPAL_REQUIRED",
          message: "Principal required in multi-tenant mode",
        });
        return;
      }
      let wiredPipeline: import("../../domain/permissions/action-lifecycle-factory.js").WiredActionLifecycle | undefined;
      if (serverPipelineFactory) {
        wiredPipeline = await serverPipelineFactory({
          principalId: principal.trim(),
          tenantId: opts.tenantId ?? "default",
          sessionId: opts.sessionId ?? crypto.randomUUID(),
          runId: crypto.randomUUID(),
          workspaceRoot: path.join(process.cwd(), ".seepient", "workspaces", principal.trim()),
          modelProviderClass: (opts.provider ?? "openai") as string,
        });
      }
      serverStreamText({ ...opts, sources: options?.sources, runtime: getServerRuntime(), wiredPipeline, toolRegistry: serverToolRegistry, tenancyMode: "multi", builtInTools: options?.builtInTools }, gatewayMiddleware).catch((err: any) => {
        // W162: generic wire text; raw detail in the request log only.
        opts.onError({
          code: "STREAM_ERROR",
          message: "Stream failed",
        });
        opts.onDone({
          text: "",
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 },
          finishReason: "error",
        });
      });
    },
    listModels,
    listSkills: () => listSkills(options?.sources),
    settingsHandlerContext,
    apiKeysFile: options?.apiKeysFile,
  };

  // Set up WebSocket (async, but we wait for it)
  const wsHandle: WsServerHandle = await setupWebSocket(server, wsCtx);

  // Cleanup resources when server closes
  server.on("close", () => {
    if (outboxFlushTimer) clearInterval(outboxFlushTimer);
    sessionManager.stopCleanup();
    wsHandle.close();
    // F4: closing the server fully detaches it from the host process — the
    // signal handlers registered at listen time are removed here, so an
    // embedder needs only `server.close()` (dispose() stays as an explicit
    // no-op-safe alias for teardown before close).
    process.removeListener("SIGINT", shutdownListener);
    process.removeListener("SIGTERM", shutdownListener);
  });

  // Graceful shutdown handler — registered ONLY when this server listens.
  // An embedder using listen:false owns its process signal handling (W130).
  const shutdown = async () => {
    console.log("[server] Shutting down...");
    // W162: in-flight keep-alive sockets would otherwise hold the close open
    // and never reach the close-event cleanup. Terminate them up front.
    server.closeAllConnections?.();
    // One bounded outbox flush so durable audit events are not lost to the
    // force-exit timer (W162).
    try {
      await Promise.race([
        serverOutboxRef?.flush() ?? Promise.resolve(),
        new Promise((resolve) => {
          const t = setTimeout(resolve, 2000);
          if (typeof t.unref === "function") t.unref();
        }),
      ]);
    } catch {
      // durability best-effort — the timer still drains via its interval
    }
    server.close(() => {
      console.log("[server] Server closed.");
      process.exit(0);
    });
    // Force exit after 5 seconds if connections do not close
    setTimeout(() => process.exit(0), 5000);
  };

  const willListen = options?.listen !== false;
  const shutdownListener = () => void shutdown();
  if (willListen) {
    process.on("SIGINT", shutdownListener);
    process.on("SIGTERM", shutdownListener);
  }

  const unhandledRejectionListener = (reason: unknown) => {
    logTransportEvent({
      level: "error",
      event: "unhandled_rejection",
      error: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  };
  process.on("unhandledRejection", unhandledRejectionListener);

  // Dispose handle (C5): full teardown — un-registers this server's signal
  // handlers AND closes the server (which also detaches the WS layer and,
  // via the close event, re-runs the handler removal idempotently).
  (server as SeepientHttpServer).dispose = () => {
    process.removeListener("SIGINT", shutdownListener);
    process.removeListener("SIGTERM", shutdownListener);
    process.removeListener("unhandledRejection", unhandledRejectionListener);
    server.close();
  };

  server.on("close", () => {
    process.removeListener("unhandledRejection", unhandledRejectionListener);
  });

  // Listen immediately unless listen: false
  if (willListen) {
    const port = resolvePort(options);
    const host = options?.host ?? process.env.SEEPIENT_HOST ?? "127.0.0.1";
    await new Promise<void>((resolve) => {
      server.listen(port, host, () => {
        // W162: port 0 means an OS-assigned ephemeral port — print the real one.
        const boundPort = (server.address() as { port?: number } | null)?.port ?? port;
        console.log(`[seepient] Server listening on ${host}:${boundPort}`);
        resolve();
      });
    });
  }

  (server as any).server = server;
  (server as any).runtime = serverRuntime;
  (server as any).getRuntime = () => serverRuntime;
  (server as any).toolRegistry = serverToolRegistry;

  return server as SeepientHttpServer;
}
