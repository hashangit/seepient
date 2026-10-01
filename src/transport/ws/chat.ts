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
      ...(msg.id ? { clientMsgId: msg.id } : {}),
    });
    return;
  }

  // W248: Fail-closed off-contract input on server surfaces
  if (typeof (msg as any).message !== "string") {
    safeSend(ws, {
      type: "error",
      code: "VALIDATION_ERROR",
      retryable: false,
      message: "Field 'message' must be a string",
      ...(msg.id ? { clientMsgId: msg.id } : {}),
    });
    return;
  }

  if (msg.options?.skills !== undefined) {
    if (!Array.isArray(msg.options.skills) || msg.options.skills.some((s) => typeof s !== "string")) {
      safeSend(ws, {
        type: "error",
        code: "VALIDATION_ERROR",
        retryable: false,
        message: "Field 'skills' must be an array of strings",
        ...(msg.id ? { clientMsgId: msg.id } : {}),
      });
      return;
    }
  }

  // FR-016 (VULN-22): Fail-closed tools array edge validation
  if ((msg.options as any)?.tools !== undefined) {
    if (!Array.isArray((msg.options as any).tools) || (msg.options as any).tools.some((t: any) => typeof t !== "string")) {
      safeSend(ws, {
        type: "error",
        code: "VALIDATION_ERROR",
        retryable: false,
        message: "Field 'tools' must be an array of strings",
        ...(msg.id ? { clientMsgId: msg.id } : {}),
      });
      return;
    }
  }

  // Busy guard: only one active chat turn per connection
  if (state.activeChats.size > 0) {
    safeSend(ws, {
      type: "error",
      code: "REQUEST_IN_FLIGHT",
      retryable: true,
      message: "Another chat turn is already in flight for this connection",
      ...(msg.id ? { clientMsgId: msg.id } : {}),
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
      ctx.sessionManager.releaseTurn(acquiredSessionId, state.apiKeyHash);
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
        if (!ctx.sessionManager.acquireTurn(session.id, state.apiKeyHash)) {
          safeSend(ws, {
            type: "error",
            code: "REQUEST_IN_FLIGHT",
            retryable: true,
            message: `Session "${session.id}" has a request already in flight`,
            ...(msg.id ? { clientMsgId: msg.id } : {}),
          });
          return;
        }
        state.sessionId = session.id;
        acquiredSessionId = session.id;

        // F1: resolve a dangling failed-turn draft before history is captured.
        ctx.sessionManager.resolveTrailingDraft(session.id, state.apiKeyHash);

        history = [...session.messages];
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (/Maximum concurrent sessions|session limit/i.test(message)) {
          safeSend(ws, {
            type: "error",
            code: "SESSION_LIMIT",
            retryable: false,
            message,
            ...(msg.id ? { clientMsgId: msg.id } : {}),
          });
          return;
        }
        if (/already exists/i.test(message) || (err as any)?.code === "SESSION_ALREADY_EXISTS") {
          safeSend(ws, {
            type: "error",
            code: "FORBIDDEN",
            retryable: false,
            message: `Session "${targetSessionId}" is not accessible`,
            ...(msg.id ? { clientMsgId: msg.id } : {}),
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
            ...(msg.id ? { clientMsgId: msg.id } : {}),
          });
          return;
        }
        // W162: generic wire text; raw detail in the ws_dispatch log only.
        logTransportEvent({
          level: "warn",
          event: "ws_dispatch",
          requestId: serverMsgId,
          method: msg.type,
          apiKeyHashPrefix: state.apiKeyHash ? state.apiKeyHash.slice(0, 8) : undefined,
          error: message,
        });
        safeSend(ws, {
          type: "error",
          code: "SESSION_ERROR",
          retryable: false,
          message: "Session error",
          ...(msg.id ? { clientMsgId: msg.id } : {}),
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
        ctx.sessionManager.addMessage(acquiredSessionId!, userMsg, state.apiKeyHash);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logTransportEvent({
          level: "warn",
          event: "ws_dispatch",
          requestId: serverMsgId,
          method: msg.type,
          apiKeyHashPrefix: state.apiKeyHash ? state.apiKeyHash.slice(0, 8) : undefined,
          error: message,
        });
        safeSend(ws, {
          type: "error",
          code: "SESSION_ERROR",
          retryable: false,
          message: "Session error",
          ...(msg.id ? { clientMsgId: msg.id } : {}),
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
          logTransportEvent({
            level: "warn",
            event: "ws_dispatch",
            requestId: msg.id || serverMsgId,
            method: msg.type,
            apiKeyHashPrefix: state.apiKeyHash ? state.apiKeyHash.slice(0, 8) : undefined,
            error: message,
          });
          safeSend(ws, {
            type: "error",
            code: "STREAM_ERROR",
            retryable: false,
            message: "Stream failed",
            ...(msg.id ? { clientMsgId: msg.id } : {}),
          });
        }
        resolve();
      };

      const envMaxSteps = process.env.SEEPIENT_MAX_STEPS ? parseInt(process.env.SEEPIENT_MAX_STEPS, 10) : undefined;
      const settingMaxSteps = ctx.settingsHandlerContext?.settingsManager?.get("server.maxSteps")?.value as number | undefined;
      const serverMaxSteps = (settingMaxSteps !== undefined && !isNaN(settingMaxSteps) && settingMaxSteps > 0)
        ? settingMaxSteps
        : (envMaxSteps !== undefined && !isNaN(envMaxSteps) && envMaxSteps > 0 ? envMaxSteps : 100);

      if (msg.options?.maxSteps !== undefined) {
        if (typeof msg.options.maxSteps !== "number" || !Number.isInteger(msg.options.maxSteps) || msg.options.maxSteps <= 0) {
          safeSend(ws, {
            type: "error",
            code: "INVALID_REQUEST",
            retryable: false,
            message: "maxSteps must be a positive integer",
            ...(msg.id ? { clientMsgId: msg.id } : {}),
          });
          return;
        }
      }

      const requestedSteps = msg.options?.maxSteps ?? 10;
      const effectiveMaxSteps = Math.min(requestedSteps, serverMaxSteps);
      const wasClamped = requestedSteps > serverMaxSteps;

      try {
        const maybePromise: unknown = ctx.streamText({
          message: msg.message,
          model,
          provider,
          tools: msg.options?.tools,
          maxSteps: effectiveMaxSteps,
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

            logTransportEvent({
              level: "warn",
              event: "ws_dispatch",
              requestId: msg.id || serverMsgId,
              method: msg.type,
              apiKeyHashPrefix: state.apiKeyHash ? state.apiKeyHash.slice(0, 8) : undefined,
              error: error.message,
            });
            safeSend(ws, {
              type: "error",
              code: error.code || "STREAM_ERROR",
              retryable: error.code === "PROVIDER_ERROR",
              message: "Stream failed",
              provider: error.provider,
              tool: error.tool,
              ...(msg.id ? { clientMsgId: msg.id } : {}),
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
                ...(wasClamped ? { effectiveMaxSteps, maxSteps: effectiveMaxSteps } : {}),
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
                  ctx.sessionManager.addMessage(acquiredSessionId, assistantMsg, state.apiKeyHash);
                } catch (err: unknown) {
                  const message = err instanceof Error ? err.message : String(err);
                  logTransportEvent({
                    level: "warn",
                    event: "ws_dispatch",
                    requestId: serverMsgId,
                    method: msg.type,
                    apiKeyHashPrefix: state.apiKeyHash ? state.apiKeyHash.slice(0, 8) : undefined,
                    error: message,
                  });
                  safeSend(ws, {
                    type: "error",
                    code: "SESSION_ERROR",
                    retryable: false,
                    message: "Session error",
                    ...(msg.id ? { clientMsgId: msg.id } : {}),
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
      message: "Stream failed",
      ...(msg.id ? { clientMsgId: msg.id } : {}),
    });
  } finally {
    releaseSessionTurn();
    state.activeChats.delete(abortController);
  }
}

export function handleAbort(
  ws: WebSocket,
  msg: AbortMessage,
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
      ...(msg.id ? { clientMsgId: msg.id } : {}),
    });
  }
}
