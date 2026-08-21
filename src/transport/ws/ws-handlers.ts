/**
 * Seepient Server — WebSocket Protocol Handlers
 *
 * All handler functions, safeSend helper, and active connections registry.
 * Extracted from websocket.ts for single-responsibility.
 */

import * as crypto from "crypto";
import { authMiddleware, hasScope } from "../auth/auth.js";
import type { ApiKeyEntry, KeyScope } from "../auth/auth.js";
import { hashKey } from "../http/session-store.js";
import type {
  WebSocket,
  WSServer,
  ClientMessage,
  ServerMessage,
  ChatMessage,
  ToolApprovalResponse,
  AbortMessage,
  ResumeMessage,
  ReconnectMessage,
  SwitchProviderMessage,
  GetSettingsMessage,
  UpdateSettingsMessage,
  ListProvidersMessage,
  SetProviderMessage,
  RemoveProviderMessage,
  WebSocketHandlerContext,
  ConnectionState,
} from "./ws-types.js";
import type { PermissionLevel } from "../../foundations/types.js";
import type {
  PermissionDecision,
  PermissionRequest,
} from "../../foundations/contracts/permission-policy.js";
import type { SettingsHandlerContext } from "../http/settings-handlers.js";
import { handleWsGetSettings, handleWsUpdateSettings, writeMutex } from "../http/settings-handlers.js";

// ── Active connections registry ──────────────────────────────────────

const activeConnections = new Map<WebSocket, ConnectionState>();

// ── Pending tool approvals ───────────────────────────────────────────

import { DurableApprovalStore } from "../../domain/permissions/durable-approval-store.js";

export const durableApprovalStore = new DurableApprovalStore();
void durableApprovalStore.load();

const pendingApprovals = new Map<string, {
  continuationId: string;
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
  ws: WebSocket;
  toolName: string;
  createdAt: number;
}>();
/**
 * Get the number of currently active WebSocket connections.
 */
export function getActiveConnectionCount(): number {
  return activeConnections.size;
}

/**
 * Get all connected WS clients (excluding the given one).
 * Used by settings broadcast to notify other connections of changes.
 */
export function getOtherClients(
  excludeWs?: WebSocket,
): Array<{ ws: WebSocket; state: ConnectionState }> {
  const clients: Array<{ ws: WebSocket; state: ConnectionState }> = [];
  for (const [ws, state] of activeConnections) {
    if (ws !== excludeWs) {
      clients.push({ ws, state });
    }
  }
  return clients;
}

// ── Send helper ──────────────────────────────────────────────────────

export function safeSend(ws: WebSocket, message: ServerMessage): void {
  try {
    if (ws.readyState === 1 /* OPEN */) {
      ws.send(JSON.stringify(message));
    }
  } catch {
    // Connection may have closed
  }
}

// ── Protocol handler ─────────────────────────────────────────────────

export function handleConnection(
  ws: WebSocket,
  req: import("http").IncomingMessage,
  ctx: WebSocketHandlerContext,
): void {
  // Auth check — the token should have been validated during upgrade,
  // but verify again for safety
  const key = authMiddleware(req);
  if (!key) {
    safeSend(ws, {
      type: "error",
      code: "UNAUTHORIZED",
      retryable: false,
      message: "Authentication required",
    });
    ws.close(4001, "Unauthorized");
    return;
  }

  const state: ConnectionState = {
    sessionId: null,
    currentAbortController: null,
    activeProvider: null,
    activeModel: null,
    maxPermissionLevel: ctx.maxPermissionLevel,
    apiKeyHash: key.keyHash ?? (key.key ? hashKey(key.key) : ""),
    apiKey: key,
  };

  activeConnections.set(ws, state);

  // ── Message dispatch ───────────────────────────────────────────────

  ws.on("message", (data: Buffer) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString("utf-8")) as ClientMessage;
    } catch {
      safeSend(ws, {
        type: "error",
        code: "INVALID_MESSAGE",
        retryable: false,
        message: "Invalid JSON message",
      });
      return;
    }

    switch (msg.type) {
      case "chat":
        handleChat(ws, msg, state, ctx);
        break;
      case "abort":
        handleAbort(ws, msg, state);
        break;
      case "tool_approval_response":
        handleToolApprovalResponse(ws, msg);
        break;
      case "resume":
        void handleResume(ws, msg, state, ctx);
        break;
      case "reconnect":
        void handleReconnect(ws, msg, state, ctx);
        break;
      case "switch_provider":
        handleSwitchProvider(ws, msg, state);
        break;
      case "list_models":
        handleListModels(ws, ctx);
        break;
      case "list_skills":
        handleListSkills(ws, ctx);
        break;
      case "ping":
        safeSend(ws, {
          type: "pong",
          serverTime: new Date().toISOString(),
        });
        break;
      case "get_settings":
        handleWsSettingsMessage(ws, msg as GetSettingsMessage, state, ctx, (sCtx) =>
          handleWsGetSettings(msg as GetSettingsMessage, ws, state, sCtx));
        break;
      case "update_settings":
        handleWsSettingsMessage(ws, msg as UpdateSettingsMessage, state, ctx, (sCtx) =>
          void handleWsUpdateSettings(msg as UpdateSettingsMessage, ws, state, sCtx));
        break;
      case "list_providers":
        handleWsSettingsMessage(ws, msg as ListProvidersMessage, state, ctx, (sCtx) =>
          void handleWsListProviders(msg as ListProvidersMessage, ws, state, sCtx));
        break;
      case "set_provider":
        handleWsSettingsMessage(ws, msg as SetProviderMessage, state, ctx, (sCtx) =>
          void handleWsSetProvider(msg as SetProviderMessage, ws, state, sCtx));
        break;
      case "remove_provider":
        handleWsSettingsMessage(ws, msg as RemoveProviderMessage, state, ctx, (sCtx) =>
          void handleWsRemoveProvider(msg as RemoveProviderMessage, ws, state, sCtx));
        break;
      default:
        safeSend(ws, {
          type: "error",
          code: "UNKNOWN_MESSAGE_TYPE",
          retryable: false,
          message: `Unknown message type: ${(msg as { type: string }).type}`,
        });
    }
  });

  // ── Close ──────────────────────────────────────────────────────────

  ws.on("close", () => {
    // Abort any in-flight stream
    if (state.currentAbortController) {
      state.currentAbortController.abort();
      state.currentAbortController = null;
    }
    activeConnections.delete(ws);
  });

  // ── Error ──────────────────────────────────────────────────────────

  ws.on("error", (err: Error) => {
    console.error("[ws] Connection error:", err.message);
    if (state.currentAbortController) {
      state.currentAbortController.abort();
      state.currentAbortController = null;
    }
    activeConnections.delete(ws);
  });
}

// ── Chat handler ─────────────────────────────────────────────────────

function handleChat(
  ws: WebSocket,
  msg: ChatMessage,
  state: ConnectionState,
  ctx: WebSocketHandlerContext,
): void {
  const serverMsgId = crypto.randomUUID();

  // Acknowledge
  safeSend(ws, {
    type: "ack",
    clientMsgId: msg.id,
    serverMsgId,
    timestamp: new Date().toISOString(),
  });

  // Create session if needed
  if (!state.sessionId && msg.sessionId) {
    state.sessionId = msg.sessionId;
  }

  // Set up abort controller
  const abortController = new AbortController();
  state.currentAbortController = abortController;

  // Resolve options with connection-level overrides
  const provider = msg.options?.provider ?? state.activeProvider ?? undefined;
  const model = msg.options?.model ?? state.activeModel ?? undefined;

  // Resolve permission level with server ceiling
  let effectivePermissionLevel: PermissionLevel | undefined = msg.options?.permissionLevel ?? state.permissionLevel;
  if (effectivePermissionLevel && state.maxPermissionLevel) {
    const levels: PermissionLevel[] = ["strict", "moderate", "permissive"];
    const maxIdx = levels.indexOf(state.maxPermissionLevel);
    const reqIdx = levels.indexOf(effectivePermissionLevel);
    // QA-009: Unknown levels (-1) are capped to the server ceiling
    if (reqIdx === -1 || reqIdx > maxIdx) {
      effectivePermissionLevel = state.maxPermissionLevel;
    }
  }

  // Stream text
  try {
    ctx.streamText({
      message: msg.message,
      model,
      provider,
      tools: msg.options?.tools,
      maxSteps: msg.options?.maxSteps ?? 10,
      skills: msg.options?.skills,
      sessionId: state.sessionId ?? undefined,
      permissionLevel: effectivePermissionLevel,
      // Spec 008: pass the authenticated API-key hash as principal identity.
      ...(state.apiKeyHash ? { apiKeyHash: state.apiKeyHash } : {}),
      approveTool: createServerApproveTool(ws),
      signal: abortController.signal,
      onText: (delta) => {
        safeSend(ws, {
          type: "text",
          delta,
          serverMsgId,
        });
      },
      onToolCall: (info) => {
        safeSend(ws, {
          type: "tool_call",
          callId: info.callId,
          name: info.name,
          args: info.args,
        });
      },
      onToolResult: (info) => {
        safeSend(ws, {
          type: "tool_result",
          callId: info.callId,
          output: info.output,
          success: info.success,
        });
      },
      onStep: (step) => {
        // Estimate progress — we don't know totalSteps ahead of time
        safeSend(ws, {
          type: "progress",
          step: 0,
          totalSteps: 0,
          percentage: 0,
          activity: step.content ?? step.type,
        });
      },
      onError: (error) => {
        safeSend(ws, {
          type: "error",
          code: error.code || "STREAM_ERROR",
          retryable: error.code === "PROVIDER_ERROR",
          message: error.message,
          provider: error.provider,
          tool: error.tool,
        });
      },
      onDone: (result) => {
        safeSend(ws, {
          type: "done",
          serverMsgId,
          usage: result.usage,
          finishReason: result.finishReason,
        });

        // Add assistant message to session
        if (state.sessionId) {
          const assistantMsg: import("../../foundations/types.js").Message = {
            id: serverMsgId,
            role: "assistant",
            content: result.text,
            timestamp: Date.now(),
          };
          ctx.sessionManager.addMessage(state.sessionId, assistantMsg);
        }

        state.currentAbortController = null;
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Stream failed";
    safeSend(ws, {
      type: "error",
      code: "STREAM_ERROR",
      retryable: false,
      message,
    });
    state.currentAbortController = null;
  }
}

// ── Abort handler ────────────────────────────────────────────────────

function handleAbort(
  ws: WebSocket,
  _msg: AbortMessage,
  state: ConnectionState,
): void {
  if (state.currentAbortController) {
    state.currentAbortController.abort();
    state.currentAbortController = null;
    safeSend(ws, {
      type: "error",
      code: "ABORTED",
      retryable: false,
      message: "Request aborted by client",
    });
  }
}

// ── Tool approval handler ────────────────────────────────────────────

const APPROVAL_TIMEOUT_MS = 30_000; // 30 seconds

/**
 * Build the durable-store request record for the WS legacy surface (spec 011
 * T022 review fix). The legacy server loop has no Domain policy evaluation on
 * this path, so the record carries ONE exact-for-this-call option: its
 * capabilities are empty (no authority is invented — the legacy loop remains
 * the sole authority) and the option only makes the approval representable so
 * the durable record and the executed outcome stay consistent. When the P4
 * server split wires the real pipeline, engine-issued options replace this.
 */
export function wsLegacyApprovalRequest(
  callId: string,
  callName: string,
  now = Date.now(),
): PermissionRequest {
  return {
    requestId: callId,
    principalId: "ws-user",
    runId: "ws-run",
    toolCallId: callId,
    actionDigest: callId,
    action: { title: callName, summary: callName, canonicalTargets: [], effects: [] },
    requestedCapabilities: [],
    approvalOptions: [
      {
        optionId: `ws-exact-${callId}`,
        actionDigest: callId,
        kind: "exact",
        label: `Only this call — ${callName} (legacy server surface)`,
        capabilities: [],
        supportedLifetimes: ["action"],
      },
    ],
    approvalChoices: [
      {
        choiceId: `ws-exact-${callId}::action`,
        optionId: `ws-exact-${callId}`,
        lifetime: "action",
        title: "Allow this action once",
        description: "You'll be asked again next time.",
        authoritySummary: [`Approve the tool call shown (${callName})`],
        recommended: true,
      },
    ],
    offeredLifetimes: ["action"],
    createdAt: now,
    expiresAt: now + APPROVAL_TIMEOUT_MS,
  };
}

/**
 * Create an `approveTool` callback for the server adapter.
 * Sends a `tool_approval_request` to the client and waits for a
 * `tool_approval_response`. Falls back to auto-deny on timeout.
 */
export function createServerApproveTool(ws: WebSocket): import("../../foundations/types.js").ApproveToolFn {
  return async (call) => {
    const callId = crypto.randomUUID();
    const continuationId = `cont-${callId}`;

    durableApprovalStore.create({
      request: wsLegacyApprovalRequest(callId, call.name),
      tenantId: "default",
      sessionId: "ws-session",
      continuationId,
    });

    safeSend(ws, {
      type: "tool_approval_request",
      callId,
      name: call.name,
      args: call.args,
    });

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        durableApprovalStore.cancel(continuationId);
        pendingApprovals.delete(callId);
        resolve(false); // Timeout → deny
      }, APPROVAL_TIMEOUT_MS);

      pendingApprovals.set(callId, { continuationId, resolve, timer, ws, toolName: call.name, createdAt: Date.now() });
    });
  };
}

async function handleToolApprovalResponse(
  ws: WebSocket,
  msg: ToolApprovalResponse,
): Promise<void> {
  const pending = pendingApprovals.get(msg.callId);
  if (!pending) return;

  // QA-001: Only the originating connection may resolve the approval
  if (pending.ws !== ws) return;

  // Defense-in-depth: verify the tool name matches the pending request
  if (msg.name !== pending.toolName) return;

  // Reject expired approvals (defense-in-depth, timer should have fired)
  if (Date.now() - pending.createdAt > APPROVAL_TIMEOUT_MS) {
    clearTimeout(pending.timer);
    pendingApprovals.delete(msg.callId);
    durableApprovalStore.cancel(pending.continuationId);
    pending.resolve(false);
    return;
  }

  // Spec 011 (T022): an approved legacy response must bind to the request's
  // narrowest policy-issued option; with no options the approval cannot be
  // represented and is denied as unavailable.
  const rec = durableApprovalStore.get(pending.continuationId);
  const decision = wsApprovalDecision(msg, rec?.request);

  const result = await durableApprovalStore.cas(pending.continuationId, 1, decision);
  clearTimeout(pending.timer);
  pendingApprovals.delete(msg.callId);

  // Execution MUST follow the validated typed decision: when the request had
  // no representable policy option, the approval was persisted as denied and
  // the tool must NOT run (spec 011 review fix). The durable record and the
  // resolved callback never disagree.
  if (result.status === "transitioned") {
    pending.resolve(decision.approved);
  } else {
    pending.resolve(false);
  }
}

/**
 * Build the strict typed decision for a WS approval response (spec 011
 * T022). An approved response is bound to the request's narrowest
 * policy-issued option; a request with no representable option can only be
 * denied as `approval-unavailable`, and the caller must let execution follow
 * this decision. Pure and exported for conformance tests.
 */
export function wsApprovalDecision(
  msg: ToolApprovalResponse,
  request: PermissionRequest | undefined,
  now = Date.now(),
): PermissionDecision {
  const option = request?.approvalOptions[0];
  if (msg.approved && option) {
    return {
      approved: true,
      requestId: msg.callId,
      actionDigest: msg.callId,
      optionId: option.optionId,
      lifetime: "action",
      actorId: "ws-user",
      decidedAt: now,
    };
  }
  return {
    approved: false,
    requestId: msg.callId,
    actionDigest: msg.callId,
    actorId: "ws-user",
    reason: msg.approved
      ? "approval-unavailable: request has no representable option"
      : undefined,
    decidedAt: now,
  };
}

// ── Resume handler ───────────────────────────────────────────────────

async function handleResume(
  ws: WebSocket,
  msg: ResumeMessage,
  state: ConnectionState,
  ctx: WebSocketHandlerContext,
): Promise<void> {
  const session = await ctx.sessionManager.getSession(msg.sessionId, state.apiKeyHash);
  if (!session) {
    safeSend(ws, {
      type: "error",
      code: "SESSION_NOT_FOUND",
      retryable: false,
      message: `Session ${msg.sessionId} not found or expired`,
    });
    return;
  }

  state.sessionId = msg.sessionId;

  safeSend(ws, {
    type: "session_resumed",
    sessionId: msg.sessionId,
    messages: session.messages,
  });
}

// ── Reconnect handler ────────────────────────────────────────────────

async function handleReconnect(
  ws: WebSocket,
  msg: ReconnectMessage,
  state: ConnectionState,
  ctx: WebSocketHandlerContext,
): Promise<void> {
  const session = await ctx.sessionManager.getSession(msg.sessionId, state.apiKeyHash);
  if (!session) {
    safeSend(ws, {
      type: "error",
      code: "SESSION_NOT_FOUND",
      retryable: false,
      message: `Session ${msg.sessionId} not found or expired`,
    });
    return;
  }

  state.sessionId = msg.sessionId;

  // Replay messages — optionally only those after lastSeenId
  let messages = session.messages;
  if (msg.lastSeenId) {
    const lastIndex = messages.findIndex((m) => m.id === msg.lastSeenId);
    if (lastIndex !== -1) {
      messages = messages.slice(lastIndex + 1);
    }
  }

  safeSend(ws, {
    type: "replay",
    messages,
    currentStatus: "ready",
  });
}

// ── Switch provider handler ──────────────────────────────────────────

function handleSwitchProvider(
  ws: WebSocket,
  msg: SwitchProviderMessage,
  state: ConnectionState,
): void {
  state.activeProvider = msg.provider;
  if (msg.model) {
    state.activeModel = msg.model;
  }

  safeSend(ws, {
    type: "ack",
    clientMsgId: "",
    serverMsgId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
  });
}

// ── List models handler ──────────────────────────────────────────────

function handleListModels(
  ws: WebSocket,
  ctx: WebSocketHandlerContext,
): void {
  safeSend(ws, {
    type: "models_list",
    models: ctx.listModels(),
  });
}

// ── List skills handler ──────────────────────────────────────────────

function handleListSkills(
  ws: WebSocket,
  ctx: WebSocketHandlerContext,
): void {
  safeSend(ws, {
    type: "skills_list",
    skills: ctx.listSkills(),
  });
}

// ── Settings dispatch helper ────────────────────────────────────────────

function handleWsSettingsMessage(
  ws: WebSocket,
  _msg: ClientMessage,
  _state: ConnectionState,
  ctx: WebSocketHandlerContext,
  fn: (sCtx: SettingsHandlerContext) => void,
): void {
  const sCtx = ctx.settingsHandlerContext;
  if (!sCtx) {
    safeSend(ws, {
      type: "error",
      code: "SERVICE_UNAVAILABLE",
      retryable: false,
      message: "Settings not configured",
    });
    return;
  }
  fn(sCtx);
}

// ── WS scope helper ─────────────────────────────────────────────────────

function requireWsScope(state: ConnectionState, scope: KeyScope): boolean {
  return !!state.apiKey && hasScope(state.apiKey, scope);
}

// ── WS Settings: list providers ─────────────────────────────────────────

export async function handleWsListProviders(
  msg: ListProvidersMessage,
  ws: WebSocket,
  state: ConnectionState,
  _ctx: SettingsHandlerContext,
): Promise<void> {
  if (!requireWsScope(state, "agent:read")) {
    safeSend(ws, { type: "providers_list", id: msg.id, providers: {}, error: { code: "FORBIDDEN", message: "Requires agent:read scope" } } as any);
    return;
  }

  const providers: Record<string, any> = {};

  try {
    const { getDefaultProviderRuntime } = await import("../../domain/providers/provider-runtime.js");
    const snapshot = await getDefaultProviderRuntime().createTurnSnapshot();
    const v2Providers = snapshot.config?.providers || {};
    for (const [id, entry] of Object.entries(v2Providers)) {
      providers[id] = {
        type: entry.upstreamProvider || entry.adapter || "custom",
        baseUrl: entry.baseUrl,
      };
    }
  } catch {}

  safeSend(ws, { type: "providers_list", id: msg.id, providers } as any);
}

// ── WS Settings: set provider ───────────────────────────────────────────

async function handleWsSetProvider(
  msg: SetProviderMessage,
  ws: WebSocket,
  state: ConnectionState,
  _ctx: SettingsHandlerContext,
): Promise<void> {
  if (!requireWsScope(state, "provider:admin")) {
    safeSend(ws, { type: "settings_updated", id: msg.id, error: { code: "FORBIDDEN", message: "Requires provider:admin scope" } } as any);
    return;
  }

  const { type: providerType, apiKey, baseUrl, model } = msg.provider;
  if (!providerType) {
    safeSend(ws, { type: "settings_updated", id: msg.id, error: { code: "VALIDATION_ERROR", message: "Invalid provider type" } } as any);
    return;
  }

  try {
    if (baseUrl) {
      const { validateEndpointUrl } = await import("../http/ssrf-validator.js");
      const allowPrivate = process.env.SEEPIENT_SSRF_ALLOW_PRIVATE === "1";
      const val = await validateEndpointUrl(baseUrl, { ssrfAllowPrivate: allowPrivate });
      if (!val.valid) {
        safeSend(ws, { type: "settings_updated", id: msg.id, error: { code: "SSRF_BLOCKED", message: val.error } } as any);
        return;
      }
    }
    const { getDefaultProviderRuntime } = await import("../../domain/providers/provider-runtime.js");
    const runtime = getDefaultProviderRuntime();
    const configStore = runtime.getConfigStore();
    const overlay = await configStore.getOverlay();
    await configStore.updateOverlay({
      providers: {
        [providerType]: {
          adapter: "pi-ai",
          upstreamProvider: providerType,
          ...(baseUrl ? { baseUrl } : {}),
          ...(apiKey ? { credential: { kind: "direct", value: apiKey } } : {}),
        },
      },
      ...(model ? {
        modelAssignments: {
          text: {
            standard: {
              providerAccount: providerType,
              model,
            },
          },
        } as any,
      } : {}),
    }, overlay.revision);
  } catch (e: any) {
    safeSend(ws, { type: "settings_updated", id: msg.id, error: { code: "SET_ERROR", message: e.message } } as any);
    return;
  }

  safeSend(ws, { type: "settings_updated", id: msg.id, applied: { [providerType]: true }, requiresRestart: false, restartAffected: [] } as any);
}

// ── WS Settings: remove provider ────────────────────────────────────────

async function handleWsRemoveProvider(
  msg: RemoveProviderMessage,
  ws: WebSocket,
  state: ConnectionState,
  _ctx: SettingsHandlerContext,
): Promise<void> {
  if (!requireWsScope(state, "provider:admin")) {
    safeSend(ws, { type: "settings_updated", id: msg.id, error: { code: "FORBIDDEN", message: "Requires provider:admin scope" } } as any);
    return;
  }

  if (!msg.providerType) {
    safeSend(ws, { type: "settings_updated", id: msg.id, error: { code: "VALIDATION_ERROR", message: "Invalid provider type" } } as any);
    return;
  }

  try {
    const { getDefaultProviderRuntime } = await import("../../domain/providers/provider-runtime.js");
    const runtime = getDefaultProviderRuntime();
    const configStore = runtime.getConfigStore();
    const overlay = await configStore.getOverlay();
    const currentProviders = { ...((overlay.patch?.providers as any) || {}) };
    delete currentProviders[msg.providerType];
    await configStore.updateOverlay({
      providers: currentProviders,
    }, overlay.revision);
  } catch (e: any) {
    safeSend(ws, { type: "settings_updated", id: msg.id, error: { code: "RESET_ERROR", message: e.message } } as any);
    return;
  }

  safeSend(ws, { type: "settings_updated", id: msg.id, applied: { removed: msg.providerType }, requiresRestart: false, restartAffected: [] } as any);
}

// ── Active connections accessor (for closeWebSocket) ──────────────────

/**
 * Close all active connections and clear the registry.
 * Used by closeWebSocket() during shutdown.
 */
export function closeAllConnections(): void {
  for (const [ws] of activeConnections) {
    try {
      ws.close(1001, "Server shutting down");
    } catch {
      // Ignore errors during shutdown
    }
  }
  activeConnections.clear();
}
