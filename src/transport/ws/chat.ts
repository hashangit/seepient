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
import type { Message } from "../../foundations/types.js";
import { safeSend } from "./connection-registry.js";
import { createServerApproveTool } from "./approvals.js";

export async function handleChat(
  ws: WebSocket,
  msg: ChatMessage,
  state: ConnectionState,
  ctx: WebSocketHandlerContext,
): Promise<void> {
  // Busy guard: only one active chat turn per connection
  if (state.activeChats.size > 0) {
    safeSend(ws, {
      type: "error",
      code: "REQUEST_IN_FLIGHT",
      retryable: true,
      message: "Another chat turn is already in flight for this connection",
    });
    return;
  }

  // Set up abort controller
  const abortController = new AbortController();
  state.activeChats.add(abortController);

  const serverMsgId = crypto.randomUUID();

  // Acknowledge
  safeSend(ws, {
    type: "ack",
    clientMsgId: msg.id,
    serverMsgId,
    timestamp: new Date().toISOString(),
  });

  // Resolve options with connection-level overrides
  const provider = msg.options?.provider ?? state.activeProvider ?? undefined;
  const model = msg.options?.model ?? state.activeModel ?? undefined;

  // Session attachment
  const targetSessionId = msg.sessionId ?? state.sessionId ?? undefined;
  if (targetSessionId) {
    try {
      let session = await ctx.sessionManager.getSession(targetSessionId, state.apiKeyHash);
      if (!session) {
        session = await ctx.sessionManager.createSession(
          state.apiKey?.key ?? state.apiKeyHash,
          {
            id: targetSessionId,
            provider,
            model,
            apiKeyHash: state.apiKeyHash,
          },
        );
      }
      state.sessionId = session.id;
    } catch (err: unknown) {
      state.activeChats.delete(abortController);
      const message = err instanceof Error ? err.message : String(err);
      if (/Maximum concurrent sessions|session limit/i.test(message)) {
        safeSend(ws, {
          type: "error",
          code: "SESSION_LIMIT",
          retryable: false,
          message,
        });
        return;
      }
      safeSend(ws, {
        type: "error",
        code: "SESSION_ERROR",
        retryable: false,
        message,
      });
      return;
    }

    if (abortController.signal.aborted) {
      state.activeChats.delete(abortController);
      return;
    }

    // Record user message before streaming
    const userMsg: Message = {
      id: msg.id,
      role: "user",
      content: msg.message,
      timestamp: Date.now(),
    };
    ctx.sessionManager.addMessage(state.sessionId, userMsg);
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
      // Spec 008 / Spec 021 review: pass authenticated identity to approval records
      ...(state.apiKeyHash ? { apiKeyHash: state.apiKeyHash } : {}),
      approveTool: createServerApproveTool(ws, {
        principalId: state.apiKeyHash,
        sessionId: state.sessionId ?? undefined,
      }),
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
        state.activeChats.delete(abortController);
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

        state.activeChats.delete(abortController);
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
    state.activeChats.delete(abortController);
  }
}

export function handleAbort(
  ws: WebSocket,
  _msg: AbortMessage,
  state: ConnectionState,
): void {
  if (state.activeChats.size > 0) {
    for (const controller of state.activeChats) {
      controller.abort();
    }
    state.activeChats.clear();
    safeSend(ws, {
      type: "error",
      code: "ABORTED",
      retryable: false,
      message: "Request aborted by client",
    });
  }
}
