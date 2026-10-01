/**
 * WebSocket Session Control, Reconnect, Skills, and Settings Message Handlers
 */

import type {
  WebSocket,
  ClientMessage,
  ResumeMessage,
  ReconnectMessage,
  ListSkillsMessage,
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
  // W140: enforce the same scope model REST enforces — session reads require agent:read
  if (!requireWsScope(state, "agent:read")) {
    safeSend(ws, {
      type: "error",
      code: "FORBIDDEN",
      retryable: false,
      message: "Requires agent:read scope",
      ...(msg.id ? { clientMsgId: msg.id } : {}),
    });
    return;
  }

  if (state.activeChats && state.activeChats.size > 0) {
    safeSend(ws, {
      type: "error",
      code: "REQUEST_IN_FLIGHT",
      retryable: true,
      message: "Cannot resume session while a stream is in flight on this connection",
      ...(msg.id ? { clientMsgId: msg.id } : {}),
    });
    return;
  }

  let session;
  try {
    session = await ctx.sessionManager.getSession(msg.sessionId, state.apiKeyHash);
  } catch (_err: unknown) {
    safeSend(ws, {
      type: "error",
      code: "SESSION_NOT_FOUND",
      retryable: false,
      message: "Session not found or expired",
      ...(msg.id ? { clientMsgId: msg.id } : {}),
    });
    return;
  }
  if (!session) {
    safeSend(ws, {
      type: "error",
      code: "SESSION_NOT_FOUND",
      retryable: false,
      message: "Session not found or expired",
      ...(msg.id ? { clientMsgId: msg.id } : {}),
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
  // W140: enforce the same scope model REST enforces — session reads require agent:read
  if (!requireWsScope(state, "agent:read")) {
    safeSend(ws, {
      type: "error",
      code: "FORBIDDEN",
      retryable: false,
      message: "Requires agent:read scope",
      ...(msg.id ? { clientMsgId: msg.id } : {}),
    });
    return;
  }

  if (state.activeChats && state.activeChats.size > 0) {
    safeSend(ws, {
      type: "error",
      code: "REQUEST_IN_FLIGHT",
      retryable: true,
      message: "Cannot reconnect session while a stream is in flight on this connection",
      ...(msg.id ? { clientMsgId: msg.id } : {}),
    });
    return;
  }

  let session;
  try {
    session = await ctx.sessionManager.getSession(msg.sessionId, state.apiKeyHash);
  } catch (_err: unknown) {
    safeSend(ws, {
      type: "error",
      code: "SESSION_NOT_FOUND",
      retryable: false,
      message: "Session not found or expired",
      ...(msg.id ? { clientMsgId: msg.id } : {}),
    });
    return;
  }
  if (!session) {
    safeSend(ws, {
      type: "error",
      code: "SESSION_NOT_FOUND",
      retryable: false,
      message: "Session not found or expired",
      ...(msg.id ? { clientMsgId: msg.id } : {}),
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

export async function handleListSkills(
  ws: WebSocket,
  msg: ListSkillsMessage | undefined,
  state: ConnectionState,
  ctx: WebSocketHandlerContext,
): Promise<void> {
  if (!requireWsScope(state, "agent:read")) {
    safeSend(ws, {
      type: "error",
      code: "FORBIDDEN",
      retryable: false,
      message: "Requires agent:read scope",
      ...(msg?.id ? { clientMsgId: msg.id } : {}),
    });
    return;
  }

  const skills = await ctx.listSkills();
  safeSend(ws, {
    type: "skills_list",
    skills,
    ...(msg?.id ? { clientMsgId: msg.id } : {}),
  });
}

export async function handleWsSettingsMessage(
  ws: WebSocket,
  msg: ClientMessage,
  _state: ConnectionState,
  ctx: WebSocketHandlerContext,
  fn: (sCtx: SettingsHandlerContext) => void | Promise<void>,
): Promise<void> {
  const sCtx = ctx.settingsHandlerContext;
  if (!sCtx) {
    safeSend(ws, {
      type: "error",
      code: "SERVICE_UNAVAILABLE",
      retryable: false,
      message: "Settings not configured",
      ...((msg as any)?.id ? { clientMsgId: (msg as any).id } : {}),
    });
    return;
  }
  await fn(sCtx);
}
