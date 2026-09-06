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
import { getDefaultProviderRuntime } from "../../domain/providers/provider-runtime.js";
import { serverGenerateText, serverStreamText } from "./server-core.js";
import { createRestHandler, type RestHandlerContext } from "./rest.js";
import { setupWebSocket, type WebSocketHandlerContext } from "../ws/websocket.js";
import { createConnectionRegistry } from "../ws/connection-registry.js";
import { ServerSessionManager } from "./session-store.js";
import { SettingsManager } from "../../domain/settings/settings-manager.js";
import type { SettingsHandlerContext } from "./settings-handlers.js";
import type { WsServerHandle } from "../ws/websocket.js";
import { loadMergedConfig, getConfigPaths, loadJsonConfig } from "../../foundations/config.js";
import { RateLimiter, globalRateLimiter } from "./rate-limit.js";

// ── Types ──────────────────────────────────────────────────────────────

import type { RunSeepientServerOptions } from "../../foundations/types.js";
export type { RunSeepientServerOptions };

interface ReadPackageJson {
  version: string;
}

/**
 * The `http.Server` returned by `runSeepientServer`, extended with a
 * `dispose()` handle that un-registers the server's process signal handlers
 * (registered only when the server listens) — W130 embedding contract.
 */
export type SeepientHttpServer = http.Server & { dispose: () => void };

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
  const getServerRuntime = () => options?.runtime ?? getDefaultProviderRuntime();

  if (serverPermissionPipelineEnabled) {
    const { buildActionLifecycle } = await import("../../domain/permissions/action-lifecycle-factory.js");
    const { NoneApprovalBroker } = await import("../approval-brokers.js");
    const { LocalAuditStore, TerminalEventOutbox, recoverIndeterminateActions } = await import("../../domain/permissions/audit-recorder.js");
    const { isLocalAuditStore } = await import("../../foundations/contracts/execution-brokers.js");
    const rootDir = process.cwd();
    const serverAuditStore = options?.auditStore ?? new LocalAuditStore({ root: rootDir });
    const isLocalStore = isLocalAuditStore(serverAuditStore);
    // The outbox MUST be backed by the SAME LocalAuditStore the per-request
    // lifecycles use, otherwise the flush timer + recovery operate on a
    // different pending-event set than the one live requests populate.
    const serverOutbox = isLocalStore ? new TerminalEventOutbox(serverAuditStore as import("../../domain/permissions/audit-recorder.js").LocalAuditStore) : undefined;

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
        policyStore: options?.policyStore,
        capabilityLedger: options?.capabilityLedger,
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
    backend: options?.persist,
  });
  sessionManager.startCleanup();

  // Create settings handler context (shared by REST and WS)
  const configPaths = getConfigPaths();
  const mergedConfig = loadMergedConfig();
  const projectConfig = loadJsonConfig(configPaths.local);
  const globalConfig = loadJsonConfig(configPaths.global);
  const settingsManager = options?.settingsManager ?? new SettingsManager({
    config: mergedConfig as unknown as Record<string, any>,
    projectConfigPath: configPaths.local,
    globalConfigPath: configPaths.global,
    projectConfig: projectConfig.config as Record<string, any>,
    globalConfig: globalConfig.config as Record<string, any>,
  });
  // W131: per-instance WS registries — never module-global
  const wsRegistry = createConnectionRegistry();
  const settingsHandlerContext: SettingsHandlerContext = {
    settingsManager,
    getOtherClients: (excludeWs) => wsRegistry.getOtherClients(excludeWs),
  };

  // Wire registered server settings: settings value -> env override -> default
  const corsOriginsSetting = settingsManager.get("server.corsOrigins").value as string | undefined;
  const maxBodyBytesSetting = settingsManager.get("server.maxBodyBytes").value as number | undefined;
  const rateLimitRpmSetting = settingsManager.get("server.rateLimitRpm").value as number | undefined;

  const serverRateLimiter = new RateLimiter(rateLimitRpmSetting ?? 300);
  globalRateLimiter.setDefaultRpm(rateLimitRpmSetting ?? 300);

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
    runtime: options?.runtime,
    generateText: async (opts) => {
      // Spec 008: construct a per-request pipeline with the authenticated
      // principal's identity. No shared state between requests.
      let wiredPipeline: import("../../domain/permissions/action-lifecycle-factory.js").WiredActionLifecycle | undefined;
      if (serverPipelineFactory) {
        wiredPipeline = await serverPipelineFactory({
          principalId: opts.principalId ?? opts.apiKeyHash ?? "anonymous",
          tenantId: opts.tenantId ?? "default",
          sessionId: opts.sessionId ?? crypto.randomUUID(),
          runId: crypto.randomUUID(),
          workspaceRoot: process.cwd(),
          modelProviderClass: (opts.provider ?? "openai") as string,
        });
      }
      return serverGenerateText({ ...opts, runtime: getServerRuntime(), wiredPipeline }, gatewayMiddleware);
    },
    listModels,
    listSkills,
    settingsHandlerContext,
    gatewayHandler,
    maxBodyBytes: maxBodyBytesSetting,
    rateLimiter: serverRateLimiter,
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
    restHandler(req, res);
  });

  // Create WebSocket handler context
  const wsCtx: WebSocketHandlerContext = {
    registry: wsRegistry,
    rateLimiter: serverRateLimiter,
    sessionManager,
    streamText: async (opts) => {
      // Spec 008: construct a per-request pipeline with the WS client's
      // authenticated identity. No shared state between connections.
      let wiredPipeline: import("../../domain/permissions/action-lifecycle-factory.js").WiredActionLifecycle | undefined;
      if (serverPipelineFactory) {
        wiredPipeline = await serverPipelineFactory({
          principalId: opts.principalId ?? opts.apiKeyHash ?? "anonymous",
          tenantId: opts.tenantId ?? "default",
          sessionId: opts.sessionId ?? crypto.randomUUID(),
          runId: crypto.randomUUID(),
          workspaceRoot: process.cwd(),
          modelProviderClass: (opts.provider ?? "openai") as string,
        });
      }
      serverStreamText({ ...opts, runtime: getServerRuntime(), wiredPipeline }, gatewayMiddleware).catch((err: any) => {
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
    settingsHandlerContext,
  };

  // Set up WebSocket (async, but we wait for it)
  const wsHandle: WsServerHandle = await setupWebSocket(server, wsCtx);

  // Cleanup resources when server closes
  server.on("close", () => {
    if (outboxFlushTimer) clearInterval(outboxFlushTimer);
    sessionManager.stopCleanup();
    wsHandle.close();
  });

  // Graceful shutdown handler — registered ONLY when this server listens.
  // An embedder using listen:false owns its process signal handling (W130).
  const shutdown = () => {
    console.log("[server] Shutting down...");
    server.close(() => {
      console.log("[server] Server closed.");
      process.exit(0);
    });
    // Force exit after 5 seconds if connections do not close
    setTimeout(() => process.exit(0), 5000);
  };

  const willListen = options?.listen !== false;
  if (willListen) {
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }

  // Dispose handle: un-registers this server's signal handlers so repeated
  // constructions in tests/embedders do not accumulate listeners.
  (server as SeepientHttpServer).dispose = () => {
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
  };

  // Listen immediately unless listen: false
  if (willListen) {
    const port = resolvePort(options);
    const host = options?.host ?? "0.0.0.0";
    await new Promise<void>((resolve) => {
      server.listen(port, host, () => {
        console.log(`[seepient] Server listening on ${host}:${port}`);
        resolve();
      });
    });
  }

  return server as SeepientHttpServer;
}
