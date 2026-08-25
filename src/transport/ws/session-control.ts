/**
 * WebSocket Session Control, Reconnect, Skills, and Settings Message Handlers
 */

import type {
  WebSocket,
  ClientMessage,
  ResumeMessage,
  ReconnectMessage,
  WebSocketHandlerContext,
  ConnectionState,
} from "./ws-types.js";
import type { KeyScope } from "../auth/auth.js";
import { hasScope } from "../auth/auth.js";
import type { SettingsHandlerContext } from "../http/settings-handlers.js";
import { safeSend } from "./connection-registry.js";

export function requireWsScope(state: ConnectionState, scope: KeyScope): boolean {
  return !!state.apiKey && hasScope(state.apiKey, scope);
}

export async function handleResume(
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

export async function handleReconnect(
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

export function handleListSkills(
  ws: WebSocket,
  ctx: WebSocketHandlerContext,
): void {
  safeSend(ws, {
    type: "skills_list",
    skills: ctx.listSkills(),
  });
}

export function handleWsSettingsMessage(
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
