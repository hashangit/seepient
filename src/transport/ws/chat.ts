/**
 * WebSocket Chat and Abort Handlers
 */

import * as crypto from "node:crypto";
import type {
  WebSocket,
  ChatMessage,
  AbortMessage,
  WebSocketHandlerContext,
  ConnectionState,
} from "./ws-types.js";
import type { PermissionLevel, Message } from "../../foundations/types.js";
import { safeSend } from "./connection-registry.js";
import { createServerApproveTool } from "./approvals.js";

export function handleChat(
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
          const assistantMsg: Message = {
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

export function handleAbort(
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
