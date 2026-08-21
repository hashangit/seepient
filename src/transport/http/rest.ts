/**
 * Seepient Server — REST Endpoint Handlers
 *
 * Processes incoming HTTP requests and routes them to the appropriate
 * handler. All responses are JSON with proper Content-Type headers.
 */

import type { IncomingMessage, ServerResponse } from "http";
import type {
  SkillMetadata,
  GenerateTextResult,
} from "../../foundations/types.js";
import { authMiddleware, hasScope } from "../auth/auth.js";
import { ServerSessionManager, hashKey } from "./session-store.js";
import {
  handleGetSettings,
  handlePatchSettings,
  handleGetSettingsSchema,
  type SettingsHandlerContext,
} from "./settings-handlers.js";

// ── Types ──────────────────────────────────────────────────────────────

export interface RestHandlerContext {
  version: string;
  startTime: number;
  sessionManager: ServerSessionManager;
  /** Generate text using the SDK */
  generateText: (options: {
    message: string;
    model?: string;
    provider?: string;
    tools?: string[];
    maxSteps?: number;
    skills?: string[];
  }) => Promise<GenerateTextResult>;
  /** List available models grouped by provider */
  listModels: () => Record<string, string[]>;
  /** List available skill metadata */
  listSkills: () => SkillMetadata[];
  /** Settings handler context — required for settings/provider routes */
  settingsHandlerContext?: SettingsHandlerContext;
  /** Gateway REST handler — delegated for all /v1/gateway/* routes */
  gatewayHandler?: (req: IncomingMessage, res: ServerResponse, path: string, method: string) => Promise<void>;
  /** Provider runtime instance */
  providerRuntime?: import("../../domain/providers/provider-runtime.js").ProviderRuntime;
}

interface ChatRequest {
  message: string;
  model?: string;
  provider?: string;
  tools?: string[];
  maxSteps?: number;
  skills?: string[];
}

// ── Helpers ────────────────────────────────────────────────────────────

function sendJSON(
  res: ServerResponse,
  statusCode: number,
  data: unknown,
): void {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(
  res: ServerResponse,
  statusCode: number,
  code: string,
  message: string,
): void {
  sendJSON(res, statusCode, { error: { code, message } });
}

function parseBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function matchRoute(
  url: string,
  method: string,
): { handler: string; params: Record<string, string> } | null {
  // Strip query string
  const path = url.split("?")[0];

  if (method === "GET" && path === "/v1/health") {
    return { handler: "health", params: {} };
  }
  if (method === "GET" && path === "/v1/models") {
    return { handler: "models", params: {} };
  }
  if (method === "GET" && path === "/v1/skills") {
    return { handler: "skills", params: {} };
  }
  if (method === "POST" && path === "/v1/chat") {
    return { handler: "chat", params: {} };
  }

  // Settings routes
  if (method === "GET" && path === "/v1/settings/schema") {
    return { handler: "settings_schema", params: {} };
  }
  if (method === "GET" && path === "/v1/settings") {
    return { handler: "settings", params: {} };
  }
  if (method === "PATCH" && path === "/v1/settings") {
    return { handler: "settings_patch", params: {} };
  }
  const settingsCategoryMatch = path.match(/^\/v1\/settings\/([a-z]+)$/);
  if (settingsCategoryMatch) {
    if (method === "GET") return { handler: "settings", params: { category: settingsCategoryMatch[1] } };
    if (method === "PATCH") return { handler: "settings_patch", params: { category: settingsCategoryMatch[1] } };
  }

  // Provider v2 routes
  if (method === "GET" && path === "/v1/provider-runtime") {
    return { handler: "provider_runtime", params: {} };
  }
  if (method === "GET" && path === "/v1/catalog") {
    return { handler: "catalog", params: {} };
  }
  if (method === "POST" && path === "/v1/models/resolve") {
    return { handler: "models_resolve", params: {} };
  }
  if (path === "/v1/models/assignments") {
    if (method === "GET") return { handler: "models_assignments", params: {} };
  }
  const assignmentMatch = path.match(/^\/v1\/models\/assignments\/([a-z-]+)(?:\/([a-z]+))?$/);
  if (assignmentMatch) {
    const purpose = assignmentMatch[1];
    const tier = assignmentMatch[2];
    if (method === "GET") return { handler: "models_assignments", params: { purpose, ...(tier ? { tier } : {}) } };
    if (method === "PUT" && tier) return { handler: "models_assignment_put", params: { purpose, tier } };
    if (method === "DELETE" && tier) return { handler: "models_assignment_delete", params: { purpose, tier } };
  }

  // Provider v2 accounts routes
  if (method === "GET" && path === "/v1/providers") {
    return { handler: "providers_v2_list", params: {} };
  }
  const providerV2Match = path.match(/^\/v1\/providers\/([a-zA-Z0-9_-]+)$/);
  if (providerV2Match) {
    const providerId = providerV2Match[1];
    if (method === "GET") return { handler: "provider_v2_get", params: { providerId } };
    if (method === "PUT") return { handler: "provider_v2_put", params: { providerId } };
    if (method === "DELETE") return { handler: "provider_v2_delete", params: { providerId } };
  }
  const probeMatch = path.match(/^\/v1\/providers\/([a-zA-Z0-9_-]+)\/probe$/);
  if (method === "POST" && probeMatch) {
    return { handler: "provider_probe", params: { providerId: probeMatch[1] } };
  }
  const refreshMatch = path.match(/^\/v1\/providers\/([a-zA-Z0-9_-]+)\/refresh-models$/);
  if (method === "POST" && refreshMatch) {
    return { handler: "provider_refresh_models", params: { providerId: refreshMatch[1] } };
  }

  // GET /v1/sessions/:id
  const sessionMatch = path.match(/^\/v1\/sessions\/([a-f0-9-]+)$/);
  if (method === "GET" && sessionMatch) {
    return { handler: "session", params: { id: sessionMatch[1] } };
  }

  // Gateway routes — delegate to gateway handler
  if (path.startsWith("/v1/gateway")) {
    return { handler: "gateway", params: { path, method } };
  }

  return null;
}

// ── Main request handler ───────────────────────────────────────────────

/**
 * Creates the main REST request handler.
 * Returns a function compatible with http.createServer().
 */
export function createRestHandler(ctx: RestHandlerContext) {
  return async function handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const route = matchRoute(req.url ?? "/", req.method ?? "GET");

    if (!route) {
      const sanitizedPath = (req.url ?? "/").split("?")[0];
      sendError(res, 404, "NOT_FOUND", `No route for ${req.method} ${sanitizedPath}`);
      return;
    }

    try {
      const getRuntime = async () => {
        if (ctx.providerRuntime) return ctx.providerRuntime;
        const { getDefaultProviderRuntime } = await import("../../domain/providers/provider-runtime.js");
        return getDefaultProviderRuntime();
      };

      switch (route.handler) {
        case "health":
          await handleHealth(req, res, ctx);
          break;
        case "models":
          await handleModels(req, res, ctx);
          break;
        case "skills":
          await handleSkills(req, res, ctx);
          break;
        case "chat":
          await handleChat(req, res, ctx);
          break;
        case "session":
          await handleGetSession(req, res, ctx, route.params.id);
          break;
        case "settings":
          await handleSettingsGet(req, res, ctx, route.params.category);
          break;
        case "settings_schema":
          await handleSettingsSchema(req, res, ctx);
          break;
        case "settings_patch":
          await handleSettingsPatch(req, res, ctx, route.params.category);
          break;
        case "provider_runtime": {
          const key = authMiddleware(req);
          if (!key) { sendError(res, 401, "UNAUTHORIZED", "Missing or invalid API key"); break; }
          const { handleGetProviderRuntime } = await import("./provider-management-handlers.js");
          await handleGetProviderRuntime(req, res, await getRuntime(), key);
          break;
        }
        case "catalog": {
          const key = authMiddleware(req);
          if (!key) { sendError(res, 401, "UNAUTHORIZED", "Missing or invalid API key"); break; }
          const { handleGetCatalog } = await import("./provider-management-handlers.js");
          await handleGetCatalog(req, res, await getRuntime(), key);
          break;
        }
        case "models_resolve": {
          const key = authMiddleware(req);
          if (!key) { sendError(res, 401, "UNAUTHORIZED", "Missing or invalid API key"); break; }
          const { handleResolveModel } = await import("./provider-management-handlers.js");
          await handleResolveModel(req, res, await getRuntime(), key);
          break;
        }
        case "models_assignments": {
          const key = authMiddleware(req);
          if (!key) { sendError(res, 401, "UNAUTHORIZED", "Missing or invalid API key"); break; }
          const { handleGetAssignments } = await import("./provider-management-handlers.js");
          await handleGetAssignments(req, res, await getRuntime(), key, route.params.purpose, route.params.tier);
          break;
        }
        case "models_assignment_put": {
          const key = authMiddleware(req);
          if (!key) { sendError(res, 401, "UNAUTHORIZED", "Missing or invalid API key"); break; }
          const { handlePutAssignment } = await import("./provider-management-handlers.js");
          await handlePutAssignment(req, res, await getRuntime(), key, route.params.purpose, route.params.tier);
          break;
        }
        case "models_assignment_delete": {
          const key = authMiddleware(req);
          if (!key) { sendError(res, 401, "UNAUTHORIZED", "Missing or invalid API key"); break; }
          const { handleDeleteAssignment } = await import("./provider-management-handlers.js");
          await handleDeleteAssignment(req, res, await getRuntime(), key, route.params.purpose, route.params.tier);
          break;
        }
        case "providers_v2_list": {
          const key = authMiddleware(req);
          if (!key) { sendError(res, 401, "UNAUTHORIZED", "Missing or invalid API key"); break; }
          const { handleGetProviders } = await import("./provider-management-handlers.js");
          await handleGetProviders(req, res, await getRuntime(), key);
          break;
        }
        case "provider_v2_get": {
          const key = authMiddleware(req);
          if (!key) { sendError(res, 401, "UNAUTHORIZED", "Missing or invalid API key"); break; }
          const { handleGetProviders } = await import("./provider-management-handlers.js");
          await handleGetProviders(req, res, await getRuntime(), key, route.params.providerId);
          break;
        }
        case "provider_v2_put": {
          const key = authMiddleware(req);
          if (!key) { sendError(res, 401, "UNAUTHORIZED", "Missing or invalid API key"); break; }
          const { handlePutProvider } = await import("./provider-management-handlers.js");
          await handlePutProvider(req, res, await getRuntime(), key, route.params.providerId);
          break;
        }
        case "provider_v2_delete": {
          const key = authMiddleware(req);
          if (!key) { sendError(res, 401, "UNAUTHORIZED", "Missing or invalid API key"); break; }
          const { handleDeleteProvider } = await import("./provider-management-handlers.js");
          await handleDeleteProvider(req, res, await getRuntime(), key, route.params.providerId);
          break;
        }
        case "provider_probe": {
          const key = authMiddleware(req);
          if (!key) { sendError(res, 401, "UNAUTHORIZED", "Missing or invalid API key"); break; }
          const urlObj = new URL(req.url ?? "/", "http://localhost");
          const full = urlObj.searchParams.get("full") === "true";
          const { handleProbeProvider } = await import("./provider-management-handlers.js");
          await handleProbeProvider(req, res, await getRuntime(), key, route.params.providerId, full);
          break;
        }
        case "provider_refresh_models": {
          const key = authMiddleware(req);
          if (!key) { sendError(res, 401, "UNAUTHORIZED", "Missing or invalid API key"); break; }
          const { handleRefreshModels } = await import("./provider-management-handlers.js");
          await handleRefreshModels(req, res, await getRuntime(), key, route.params.providerId);
          break;
        }
        case "gateway":
          if (!ctx.gatewayHandler) {
            sendError(res, 503, "SERVICE_UNAVAILABLE", "Gateway not configured");
            break;
          }
          await ctx.gatewayHandler(req, res, route.params.path as string, route.params.method as string);
          break;
        default:
          sendError(res, 404, "NOT_FOUND", "Unknown endpoint");
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal server error";
      console.error("[rest] Unhandled error:", message);
      sendError(res, 500, "INTERNAL_ERROR", message);
    }
  };
}

// ── Individual handlers ────────────────────────────────────────────────

async function handleHealth(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RestHandlerContext,
): Promise<void> {
  sendJSON(res, 200, {
    status: "ok",
    version: ctx.version,
    uptime: Math.floor((Date.now() - ctx.startTime) / 1000),
  });
}

async function handleModels(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RestHandlerContext,
): Promise<void> {
  const key = authMiddleware(req);
  if (!key) {
    sendError(res, 401, "UNAUTHORIZED", "Missing or invalid API key");
    return;
  }

  sendJSON(res, 200, { models: ctx.listModels() });
}

async function handleSkills(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RestHandlerContext,
): Promise<void> {
  const key = authMiddleware(req);
  if (!key) {
    sendError(res, 401, "UNAUTHORIZED", "Missing or invalid API key");
    return;
  }

  sendJSON(res, 200, { skills: ctx.listSkills() });
}

async function handleChat(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RestHandlerContext,
): Promise<void> {
  // Auth
  const key = authMiddleware(req);
  if (!key) {
    sendError(res, 401, "UNAUTHORIZED", "Missing or invalid API key");
    return;
  }

  if (!hasScope(key, "agent:run")) {
    sendError(res, 403, "FORBIDDEN", "API key lacks 'agent:run' scope");
    return;
  }

  // Parse body
  let body: string;
  try {
    body = await parseBody(req);
  } catch {
    sendError(res, 400, "BAD_REQUEST", "Failed to read request body");
    return;
  }

  let parsed: ChatRequest;
  try {
    parsed = JSON.parse(body) as ChatRequest;
  } catch {
    sendError(res, 400, "BAD_REQUEST", "Invalid JSON in request body");
    return;
  }

  // Validate
  if (!parsed.message || typeof parsed.message !== "string") {
    sendError(res, 400, "BAD_REQUEST", "Field 'message' is required and must be a string");
    return;
  }

  // Execute
  try {
    const result = await ctx.generateText({
      message: parsed.message,
      model: parsed.model,
      provider: parsed.provider,
      tools: parsed.tools,
      maxSteps: parsed.maxSteps ?? 10,
      skills: parsed.skills,
      // Spec 008: pass authenticated principal identity (hashed API key) so
      // the per-request pipeline constructor derives `principalId` from it.
      apiKeyHash: key.keyHash ?? (key.key ? hashKey(key.key) : ""),
    } as any);

    sendJSON(res, 200, {
      text: result.text,
      toolCalls: result.toolCalls,
      usage: result.usage,
      finishReason: result.finishReason,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Generation failed";
    const isProviderError =
      message.includes("not configured") || message.includes("API key");

    sendJSON(res, isProviderError ? 502 : 500, {
      error: {
        code: isProviderError ? "PROVIDER_ERROR" : "GENERATION_ERROR",
        message,
      },
    });
  }
}

async function handleGetSession(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RestHandlerContext,
  sessionId: string,
): Promise<void> {
  const key = authMiddleware(req);
  if (!key) {
    sendError(res, 401, "UNAUTHORIZED", "Missing or invalid API key");
    return;
  }

  if (!hasScope(key, "agent:read")) {
    sendError(res, 403, "FORBIDDEN", "API key lacks 'agent:read' scope");
    return;
  }

  const session = await ctx.sessionManager.getSession(sessionId, key.keyHash ?? (key.key ? hashKey(key.key) : ""));
  if (!session) {
    sendError(res, 404, "NOT_FOUND", `Session ${sessionId} not found`);
    return;
  }

  sendJSON(res, 200, session);
}

// ── Settings handler wrappers ────────────────────────────────────────────

// Note: These require a SettingsHandlerContext with settingsManager.
// The server setup code must extend RestHandlerContext or provide settingsManager separately.
// For now, these check for settingsManager availability and return 503 if not configured.

function getSettingsCtx(ctx: RestHandlerContext): SettingsHandlerContext | null {
  return ctx.settingsHandlerContext ?? null;
}

async function handleSettingsGet(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RestHandlerContext,
  category?: string,
): Promise<void> {
  const key = authMiddleware(req);
  if (!key) { sendError(res, 401, "UNAUTHORIZED", "Missing or invalid API key"); return; }
  (req as any).apiKey = key;

  const sCtx = getSettingsCtx(ctx);
  if (!sCtx) { sendError(res, 503, "SERVICE_UNAVAILABLE", "Settings not configured"); return; }
  await handleGetSettings(req, res, sCtx, category);
}

async function handleSettingsSchema(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RestHandlerContext,
): Promise<void> {
  const key = authMiddleware(req);
  if (!key) { sendError(res, 401, "UNAUTHORIZED", "Missing or invalid API key"); return; }
  (req as any).apiKey = key;

  const sCtx = getSettingsCtx(ctx);
  if (!sCtx) { sendError(res, 503, "SERVICE_UNAVAILABLE", "Settings not configured"); return; }
  await handleGetSettingsSchema(req, res, sCtx);
}

async function handleSettingsPatch(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RestHandlerContext,
  category?: string,
): Promise<void> {
  const key = authMiddleware(req);
  if (!key) { sendError(res, 401, "UNAUTHORIZED", "Missing or invalid API key"); return; }
  (req as any).apiKey = key;

  const sCtx = getSettingsCtx(ctx);
  if (!sCtx) { sendError(res, 503, "SERVICE_UNAVAILABLE", "Settings not configured"); return; }
  await handlePatchSettings(req, res, sCtx, category);
}
