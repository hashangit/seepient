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
import { requireWsScope } from "./session-control.js";
import { logTransportEvent } from "../logging.js";

export async function handleChat(
  ws: WebSocket,
  msg: ChatMessage,
  state: ConnectionState,
  ctx: WebSocketHandlerContext,
): Promise<void> {
  // W140: enforce the same scope model REST enforces — chat requires agent:run
  if (!requireWsScope(state, "agent:run")) {
    safeSend(ws, {
      type: "error",
      code: "FORBIDDEN",
      retryable: false,
      message: "Requires agent:run scope",
    });
    return;
  }

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
  let acquiredSessionId: string | null = null;

  const releaseSessionTurn = () => {
    if (acquiredSessionId) {
      ctx.sessionManager.releaseTurn(acquiredSessionId);
      acquiredSessionId = null;
    }
  };

  try {
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
    const requestedSessionId =
      typeof msg.sessionId === "string" && msg.sessionId.trim().length > 0
        ? msg.sessionId.trim()
        : undefined;
    const targetSessionId = requestedSessionId ?? state.sessionId ?? undefined;
    let history: Message[] | undefined;

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
        // W154d: pin the connection to the session only after the turn lock
        // is acquired — a busy-reject must not re-pin the connection.
        if (!ctx.sessionManager.acquireTurn(session.id)) {
          safeSend(ws, {
            type: "error",
            code: "REQUEST_IN_FLIGHT",
            retryable: true,
            message: `Session "${session.id}" has a request already in flight`,
          });
          return;
        }
        state.sessionId = session.id;
        acquiredSessionId = session.id;

        history = [...session.messages];
      } catch (err: unknown) {
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
        if (/already exists/i.test(message) || (err as any)?.code === "SESSION_ALREADY_EXISTS") {
          safeSend(ws, {
            type: "error",
            code: "SESSION_NOT_FOUND",
            retryable: false,
            message: "Session not found or expired",
          });
          return;
        }
        if (/server owner/i.test(message) || (err as any)?.code === "NOT_FOUND") {
          // W154f: keep the teaching error diagnosable by operators.
          logTransportEvent({
            level: "warn",
            event: "session_resume_refused",
            requestId: serverMsgId,
            apiKeyHashPrefix: state.apiKeyHash ? state.apiKeyHash.slice(0, 8) : undefined,
            error: message,
          });
          safeSend(ws, {
            type: "error",
            code: "SESSION_NOT_FOUND",
            retryable: false,
            message: "Session not found or expired",
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
        return;
      }

      // Record user message before streaming (catch session errors)
      try {
        const userMsg: Message = {
          id: msg.id,
          role: "user",
          content: msg.message,
          timestamp: Date.now(),
        };
        ctx.sessionManager.addMessage(acquiredSessionId!, userMsg);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        safeSend(ws, {
          type: "error",
          code: "SESSION_ERROR",
          retryable: false,
          message,
        });
        return;
      }
    }

    // Stream text and await completion
    let terminalFired = false;
    await new Promise<void>((resolve) => {
      abortController.signal.addEventListener(
        "abort",
        () => {
          if (!terminalFired) {
            terminalFired = true;
            resolve();
          }
        },
        { once: true },
      );

      const handleStreamError = (err: unknown) => {
        const message = err instanceof Error ? err.message : "Stream failed";
        logTransportEvent({
          level: "error",
          event: "ws_dispatch",
          requestId: msg.id || serverMsgId,
          apiKeyHashPrefix: state.apiKeyHash ? state.apiKeyHash.slice(0, 8) : undefined,
          error: message,
        });
        if (!terminalFired) {
          terminalFired = true;
          safeSend(ws, {
            type: "error",
            code: "STREAM_ERROR",
            retryable: false,
            message,
          });
        }
        resolve();
      };

      try {
        const maybePromise: unknown = ctx.streamText({
          message: msg.message,
          model,
          provider,
          tools: msg.options?.tools,
          maxSteps: msg.options?.maxSteps ?? 10,
          skills: msg.options?.skills,
          sessionId: acquiredSessionId ?? undefined,
          history,
          // Spec 008 / Spec 021 review: pass authenticated identity to approval records
          ...(state.apiKeyHash ? { apiKeyHash: state.apiKeyHash } : {}),
          approveTool: createServerApproveTool(ws, ctx.registry, {
            principalId: state.apiKeyHash,
            sessionId: acquiredSessionId ?? undefined,
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
            if (terminalFired) return;
            terminalFired = true;

            safeSend(ws, {
              type: "error",
              code: error.code || "STREAM_ERROR",
              retryable: error.code === "PROVIDER_ERROR",
              message: error.message,
              provider: error.provider,
              tool: error.tool,
            });
            resolve();
          },
          onDone: (result) => {
            if (terminalFired) return;
            terminalFired = true;

            if (result.finishReason !== "error") {
              safeSend(ws, {
                type: "done",
                serverMsgId,
                usage: result.usage,
                finishReason: result.finishReason,
              });

              // Add assistant message to session only on non-error finish
              if (acquiredSessionId) {
                try {
                  const assistantMsg: Message = {
                    id: serverMsgId,
                    role: "assistant",
                    content: result.text,
                    timestamp: Date.now(),
                  };
                  ctx.sessionManager.addMessage(acquiredSessionId, assistantMsg);
                } catch (err: unknown) {
                  const message = err instanceof Error ? err.message : String(err);
                  safeSend(ws, {
                    type: "error",
                    code: "SESSION_ERROR",
                    retryable: false,
                    message,
                  });
                }
              }
            }
            resolve();
          },
        });
        if (maybePromise && typeof (maybePromise as any).catch === "function") {
          (maybePromise as Promise<any>).catch(handleStreamError);
        }
      } catch (err: unknown) {
        handleStreamError(err);
      }
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Stream failed";
    logTransportEvent({
      level: "error",
      event: "ws_dispatch",
      requestId: msg.id || serverMsgId,
      apiKeyHashPrefix: state.apiKeyHash ? state.apiKeyHash.slice(0, 8) : undefined,
      error: message,
    });
    safeSend(ws, {
      type: "error",
      code: "STREAM_ERROR",
      retryable: false,
      message,
    });
  } finally {
    releaseSessionTurn();
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
