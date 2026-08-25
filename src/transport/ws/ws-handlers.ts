/**
 * Seepient Server — WebSocket Protocol Connection Dispatcher
 *
 * Dispatches incoming messages to focused sibling handlers.
 */

import type { IncomingMessage } from "node:http";
import { authMiddleware } from "../auth/auth.js";
import { hashKey } from "../http/session-store.js";
import type {
  WebSocket,
  ClientMessage,
  GetSettingsMessage,
  UpdateSettingsMessage,
  ListProvidersMessage,
  SetProviderMessage,
  RemoveProviderMessage,
  WebSocketHandlerContext,
  ConnectionState,
} from "./ws-types.js";
import {
  handleWsGetSettings,
  handleWsUpdateSettings,
} from "../http/settings-handlers.js";
import { activeConnections, safeSend } from "./connection-registry.js";
import { handleChat, handleAbort } from "./chat.js";
import { handleToolApprovalResponse } from "./approvals.js";
import {
  handleResume,
  handleReconnect,
  handleListSkills,
  handleWsSettingsMessage,
} from "./session-control.js";
import {
  handleSwitchProvider,
  handleListModels,
  handleWsListProviders,
  handleWsSetProvider,
  handleWsRemoveProvider,
} from "./provider-mutations.js";

// ── Protocol handler ─────────────────────────────────────────────────

export function handleConnection(
  ws: WebSocket,
  req: IncomingMessage,
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
