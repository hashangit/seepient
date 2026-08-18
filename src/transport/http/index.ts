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
import { homedir } from "os";

import type { ProviderType, PermissionLevel } from "../../foundations/types.js";
import { configureProviders, resolveFromEnv } from "../../domain/providers/provider-resolver.js";
import { serverGenerateText, serverStreamText } from "./server-core.js";
import { createRestHandler, type RestHandlerContext } from "./rest.js";
import { setupWebSocket, closeWebSocket, type WebSocketHandlerContext } from "../ws/websocket.js";
import { createServerApproveTool, getOtherClients } from "../ws/ws-handlers.js";
import { ServerSessionManager } from "./session-store.js";
import { SettingsManager } from "../../domain/settings/settings-manager.js";
import type { SettingsHandlerContext } from "./settings-handlers.js";
import { loadMergedConfig, getConfigPaths, loadJsonConfig } from "../../foundations/config.js";
import { MODEL_CATALOG } from "../../foundations/models-catalog.js";

// ── Types ──────────────────────────────────────────────────────────────

export interface ServerOptions {
  /** Port to listen on (default: SEEPIENT_PORT, PORT, or 7337) */
  port?: number;
  /** Host to bind to (default: "0.0.0.0") */
  host?: string;
  /** Enable CORS headers (default: true) */
  cors?: boolean;
  /** Session TTL in seconds (default: 86400 = 24 hours) */
  sessionTTL?: number;
  /** Default permission level for REST endpoints (default: "moderate") */
  permissionLevel?: PermissionLevel;
  /** Maximum permission level clients can request (caps WebSocket messages) */
  maxPermissionLevel?: PermissionLevel;
  /** Spec 008: route every tool call through the Domain policy pipeline. */
  permissionPipeline?: boolean;
}

interface ReadPackageJson {
  version: string;
}

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

function resolvePort(options?: ServerOptions): number {
  if (options?.port) return options.port;
  const fromEnv = parseInt(process.env.SEEPIENT_PORT ?? process.env.PORT ?? "", 10);
  if (!isNaN(fromEnv) && fromEnv > 0) return fromEnv;
  return 7337;
}

// ── Provider initialization ────────────────────────────────────────────

function initializeProvidersFromEnv(): void {
  const config = resolveFromEnv();
  if (config) {
    configureProviders(config);
  }
}

function listModels(): Record<ProviderType, string[]> {
  const result: Record<ProviderType, string[]> = {
    openai: [],
    anthropic: [],
    glm: [],
    "openai-compatible": [],
  };

  for (const [provider, entries] of Object.entries(MODEL_CATALOG)) {
    if (provider in result) {
      result[provider as ProviderType] = entries.map((e) => e.id);
    }
  }

  return result;
}

/**
 * Cached skill list — populated asynchronously at startup.
 */
let cachedSkillList: { name: string; description: string; tags: string[] }[] = [];

/**
 * Initialize the skill registry and cache the skill metadata list.
 * Called once during server startup.
 */
export async function initializeSkills(): Promise<void> {
  try {
    const { initializeSkillRegistry } = await import("../../capabilities/skills/index.js");
    const registry = await initializeSkillRegistry(process.cwd());
    cachedSkillList = registry.getMetadata().map((s) => ({
      name: s.name,
      description: s.description,
      tags: s.tags,
    }));
  } catch {
    // Skills system not available — keep empty list
  }
}

function listSkills(): { name: string; description: string; tags: string[] }[] {
  return cachedSkillList;
}

// ── CORS helper ────────────────────────────────────────────────────────

function addCORSHeaders(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const origin = req.headers.origin ?? "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
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
export async function createServer(options?: ServerOptions): Promise<http.Server> {
  const version = resolveVersion();
  const startTime = Date.now();

  // Initialize providers from environment
  initializeProvidersFromEnv();

  const serverPermissionLevel = options?.permissionLevel ?? "moderate";

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
  let serverPipelineFactory: PipelineFactory | undefined;
  const serverPermissionPipelineEnabled = options?.permissionPipeline !== false && process.env.SEEPIENT_PERMISSION_PIPELINE !== "0";
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
  if (serverPermissionPipelineEnabled) {
    const { buildActionLifecycle } = await import("../../domain/permissions/action-lifecycle-factory.js");
    const { NoneApprovalBroker } = await import("../approval-brokers.js");
    const { LocalAuditStore, TerminalEventOutbox, recoverIndeterminateActions } = await import("../../domain/permissions/audit-recorder.js");
    const rootDir = process.cwd();
    const serverAuditStore = new LocalAuditStore({ root: rootDir });
    // The outbox MUST be backed by the SAME LocalAuditStore the per-request
    // lifecycles use, otherwise the flush timer + recovery operate on a
    // different pending-event set than the one live requests populate.
    const serverOutbox = new TerminalEventOutbox(serverAuditStore);

    // The periodic flush timer MUST start regardless of whether the one-time
    // recovery (reload/flush/recover) succeeds — a recovery failure must not
    // leave the server running with no drain path. Create it outside the try.
    try {
      await serverOutbox.reload();
      await serverOutbox.flush();
      await recoverIndeterminateActions(serverAuditStore, serverOutbox);
    } catch (e) {
      console.warn("[server] Audit outbox recovery initialization failed:", e instanceof Error ? e.message : String(e));
    }
    outboxFlushTimer = setInterval(() => {
      serverOutbox.flush().catch(() => {});
    }, 10_000);
    outboxFlushTimer.unref();

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
            message: "Server-side effect execution is disabled in this release; use the local CLI/SDK.",
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
        terminalOutbox: serverOutbox,
      });
    };
  }

  // Resolve session directory
  const sessionDir = process.env.SEEPIENT_SESSION_DIR ??
    path.join(process.cwd(), ".seepient", "sessions");

  const sessionTTL = (options?.sessionTTL ?? parseInt(process.env.SEEPIENT_SESSION_TTL ?? "86400", 10)) * 1000;

  // Create session manager
  const sessionManager = new ServerSessionManager({
    sessionDir,
    sessionTTL,
  });
  sessionManager.startCleanup();

  // Create settings handler context (shared by REST and WS)
  const configPaths = getConfigPaths();
  const mergedConfig = loadMergedConfig();
  const projectConfig = loadJsonConfig(configPaths.local);
  const globalConfig = loadJsonConfig(configPaths.global);
  const settingsManager = new SettingsManager({
    config: mergedConfig as unknown as Record<string, any>,
    projectConfigPath: configPaths.local,
    globalConfigPath: configPaths.global,
    projectConfig: projectConfig.config as Record<string, any>,
    globalConfig: globalConfig.config as Record<string, any>,
  });
  const settingsHandlerContext: SettingsHandlerContext = {
    settingsManager,
    getOtherClients,
  };

  // Initialize gateway (if enabled)
  let gatewayHandler: ((req: any, res: any, path: string, method: string) => Promise<void>) | undefined;
  let gatewayMiddleware: import("../../foundations/contracts/middleware.js").Middleware[] | undefined;
  try {
    const gwEnabled = settingsManager.get("gateway.enabled").value as boolean;
    if (gwEnabled) {
      const gatewayConfig = {
        enabled: true,
        semanticTopK: settingsManager.get("gateway.semanticTopK").value as number,
        defaultRateLimitPerMin: settingsManager.get("gateway.defaultRateLimitPerMin").value as number,
        maxAuditLogsInMemory: settingsManager.get("gateway.maxAuditLogs").value as number,
      };

      const { GatewaySettingsAdapter } = await import("../../capabilities/gateway/settings-adapter.js");
      const gatewayStorageDir = process.env.SEEPIENT_GATEWAY_DIR ?? path.join(homedir(), ".seepient");
      const gwSettingsAdapter = new GatewaySettingsAdapter(gatewayStorageDir);
      await gwSettingsAdapter.initialize();

      // Use createGateway factory — proxy tools are registered into the Domain registry here (composition root)
      const { createGateway } = await import("../../capabilities/gateway/index.js");
      const { registerTool } = await import("../../domain/tool-executor.js");
      const gatewayInstance = await createGateway(gatewayConfig, gwSettingsAdapter, undefined, (tools) => tools.forEach(registerTool));

      if (gatewayInstance) {
        const { createGatewayRestHandler } = await import("./rest-gateway.js");
        const { importOpenApiSpec } = await import("../../capabilities/gateway/openapi-importer.js");
        gatewayHandler = createGatewayRestHandler({ gateway: gatewayInstance, settingsAdapter: gwSettingsAdapter, importOpenApiSpec });

        // Wire semantic injection middleware
        const { semanticToolInjectionMiddleware } = await import("../../domain/middleware/semantic-tools.js");
        gatewayMiddleware = [semanticToolInjectionMiddleware(gatewayInstance, gatewayConfig.semanticTopK)];
      }
    }
  } catch (e) {
    console.error("[server] Gateway initialization failed:", e instanceof Error ? e.message : String(e));
  }

  // Create REST handler context
  const restCtx: RestHandlerContext = {
    version,
    startTime,
    sessionManager,
    generateText: async (opts) => {
      // Spec 008: construct a per-request pipeline with the authenticated
      // principal's identity. No shared state between requests.
      let wiredPipeline: import("../../domain/permissions/action-lifecycle-factory.js").WiredActionLifecycle | undefined;
      if (serverPipelineFactory) {
        wiredPipeline = await serverPipelineFactory({
          principalId: (opts as { apiKeyHash?: string }).apiKeyHash ?? "anonymous",
          tenantId: (opts as { tenantId?: string }).tenantId ?? "default",
          sessionId: (opts as { sessionId?: string }).sessionId ?? `sess-${Date.now()}`,
          runId: `run-${Date.now()}`,
          workspaceRoot: process.cwd(),
          modelProviderClass: (opts.provider ?? "openai") as string,
        });
      }
      return serverGenerateText({ ...opts, wiredPipeline }, serverPermissionLevel, gatewayMiddleware);
    },
    listModels,
    listSkills,
    settingsHandlerContext,
    gatewayHandler,
  };

  const restHandler = createRestHandler(restCtx);

  // Create HTTP server
  const enableCors = options?.cors ?? true;

  const server = http.createServer((req, res) => {
    // CORS
    if (enableCors) {
      addCORSHeaders(req, res);
    }

    // Preflight
    if (isPreflight(req)) {
      handlePreflight(req, res);
      return;
    }

    // Delegate to REST handler
    restHandler(req, res);
  });

  // Create WebSocket handler context
  const wsCtx: WebSocketHandlerContext = {
    sessionManager,
    streamText: async (opts) => {
      // Spec 008: construct a per-request pipeline with the WS client's
      // authenticated identity. No shared state between connections.
      let wiredPipeline: import("../../domain/permissions/action-lifecycle-factory.js").WiredActionLifecycle | undefined;
      if (serverPipelineFactory) {
        wiredPipeline = await serverPipelineFactory({
          principalId: (opts as { apiKeyHash?: string }).apiKeyHash ?? "anonymous",
          tenantId: (opts as { tenantId?: string }).tenantId ?? "default",
          sessionId: opts.sessionId ?? `sess-${Date.now()}`,
          runId: `run-${Date.now()}`,
          workspaceRoot: process.cwd(),
          modelProviderClass: (opts.provider ?? "openai") as string,
        });
      }
      serverStreamText({ ...opts, wiredPipeline }, serverPermissionLevel, gatewayMiddleware).catch((err: any) => {
        opts.onError({
          code: "STREAM_ERROR",
          message: err instanceof Error ? err.message : "Stream failed",
        });
        opts.onDone({
          text: "",
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 },
          finishReason: "error",
        });
      });
    },
    listModels,
    listSkills,
    maxPermissionLevel: options?.maxPermissionLevel,
    settingsHandlerContext,
  };

  // Set up WebSocket (async, but we wait for it)
  await setupWebSocket(server, wsCtx);

  // Graceful shutdown handler
  const shutdown = () => {
    console.log("[server] Shutting down...");
    if (outboxFlushTimer) clearInterval(outboxFlushTimer);
    sessionManager.stopCleanup();
    closeWebSocket();
    server.close(() => {
      console.log("[server] Server closed.");
      process.exit(0);
    });
    // Force exit after 5 seconds if connections don't close
    setTimeout(() => process.exit(0), 5000);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return server;
}

// ── Convenience starter ────────────────────────────────────────────────

/**
 * Create and start listening. Returns the running server.
 */
export async function startServer(options?: ServerOptions): Promise<http.Server> {
  const server = await createServer(options);

  const port = resolvePort(options);
  const host = options?.host ?? "0.0.0.0";

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      console.log(`[seepient] Server listening on ${host}:${port}`);
      resolve(server);
    });
  });
}
