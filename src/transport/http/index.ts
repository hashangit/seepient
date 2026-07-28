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
  let serverPipelineFactory: PipelineFactory | undefined;
  const serverPermissionPipelineEnabled = options?.permissionPipeline !== false && process.env.SEEPIENT_PERMISSION_PIPELINE !== "0";
  if (serverPermissionPipelineEnabled) {
    const { buildActionLifecycle } = await import("../../domain/permissions/action-lifecycle-factory.js");
    const { NoneApprovalBroker } = await import("../approval-brokers.js");
    serverPipelineFactory = async (identity) => {
      let boundary: import("../../foundations/contracts/execution-boundary.js").ExecutionBoundary;
      if (process.env.SEEPIENT_WORKER_SCHEDULER_ENDPOINT) {
        // T405: control plane delegates to the scheduler. A real deployment
        // injects a real scheduler client; without one, the boundary reports
        // backend-unsupported (fail closed) rather than executing in-process.
        const { WorkerExecutionBoundary } = await import("../../capabilities/execution/worker-execution-boundary.js");
        boundary = new WorkerExecutionBoundary({
          scheduler: {
            async dispatch() {
              throw new Error("SEEPIENT_WORKER_SCHEDULER_ENDPOINT set but no scheduler client wired — configure one in createServer()");
            },
            async cancel() {},
          },
          auth: { controlPlaneId: "control-plane-1", authenticatedTransport: "mtls" },
          signingKeyId: "cp-key-1",
          sign: (c) => `cp-sig:${c.slice(0, 8)}`,
          resolveWorkspace: () => ({
            leaseId: `lease-${identity.runId}`,
            tenantId: identity.tenantId,
            sessionId: identity.sessionId,
            workspaceId: `ws-${identity.tenantId}`,
            mountTarget: "/workspace",
            expiresAt: Date.now() + 60_000,
          }),
          capabilities: {
            backend: "docker-worker",
            capabilityKinds: ["commit-file", "read-file", "process", "model-egress", "network-destination"],
            exactCommit: true, hostFilteredEgress: true, environmentIsolation: true,
            supportedOperationKinds: ["none", "read-file", "commit-files", "process", "broker"],
          },
        });
      } else {
        const { buildLocalBoundary } = await import("../../capabilities/execution/build-local-boundary.js");
        const localResult = await buildLocalBoundary();
        boundary = localResult.boundary;
        return buildActionLifecycle({
          principalId: identity.principalId,
          runId: identity.runId,
          workspaceRoot: identity.workspaceRoot,
          modelProviderClass: identity.modelProviderClass,
          approvalBroker: new NoneApprovalBroker(),
          executionBoundary: boundary,
          approvalMode: "never",
          artifacts: localResult.artifacts,
        });
      }
      // Worker path (scheduler configured) — buildActionLifecycle below.
      return buildActionLifecycle({
        principalId: identity.principalId,
        runId: identity.runId,
        workspaceRoot: identity.workspaceRoot,
        modelProviderClass: identity.modelProviderClass,
        approvalBroker: new NoneApprovalBroker(),
        executionBoundary: boundary,
        approvalMode: "never",
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
      serverStreamText({ ...opts, wiredPipeline }, serverPermissionLevel, gatewayMiddleware).catch((err) => {
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
