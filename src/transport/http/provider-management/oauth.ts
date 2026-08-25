/**
 * REST Handlers for Provider OAuth Authentication API
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { ProviderRuntime } from "../../../domain/providers/provider-runtime.js";
import type { ApiKeyEntry } from "../../auth/auth.js";
import { hasScope } from "../../auth/auth.js";
import { redactString } from "../../../foundations/security/redact.js";
import { createOAuthInteractionShim, createProviderManagerApi } from "../../cli/provider-manager-api.js";
import {
  sendJSON,
  sendError,
  parseBody,
  checkDeploymentMode,
} from "./http-util.js";

interface PendingOAuthAttempt {
  attemptId: string;
  providerId: string;
  upstream: string;
  createdAt: number;
  expiresAt: number;
  userCode?: string;
  verificationUrl?: string;
  loginPromise?: Promise<any>;
  abortController?: AbortController;
}

const pendingOAuthAttempts = new Map<string, PendingOAuthAttempt>();

const MAX_PENDING_OAUTH_ATTEMPTS = 50;

function cleanExpiredAttempts(): void {
  const now = Date.now();
  for (const [id, att] of pendingOAuthAttempts.entries()) {
    if (now > att.expiresAt) {
      try {
        att.abortController?.abort();
      } catch {}
      pendingOAuthAttempts.delete(id);
    }
  }
}

export async function handleOAuthStart(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: ProviderRuntime,
  key: ApiKeyEntry,
  providerId: string,
): Promise<void> {
  if (!checkDeploymentMode(res)) return;
  if (!hasScope(key, "provider:admin")) {
    sendError(res, 403, "FORBIDDEN", "API key lacks 'provider:admin' scope");
    return;
  }

  cleanExpiredAttempts();

  if (pendingOAuthAttempts.size >= MAX_PENDING_OAUTH_ATTEMPTS) {
    sendError(res, 429, "TOO_MANY_REQUESTS", "Too many concurrent pending OAuth attempts. Please wait or complete existing attempts.");
    return;
  }

  const { isOAuthSupported, getOAuthFlow } = await import(
    "../../../domain/providers/oauth-service.js"
  );

  const snapshot = await runtime.createTurnSnapshot();
  const existing = snapshot.config.providers?.[providerId];
  const upstream = existing?.upstreamProvider ?? providerId;

  if (!isOAuthSupported(upstream)) {
    sendError(res, 400, "OAUTH_UNSUPPORTED", `OAuth is not supported for provider "${upstream}"`);
    return;
  }

  const flow = await getOAuthFlow(upstream);
  if (!flow) {
    sendError(res, 500, "OAUTH_FLOW_ERROR", `Could not initialize OAuth flow for "${upstream}"`);
    return;
  }

  const attemptId = `oauth_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const abortController = new AbortController();
  let notifyResolve: (info: { userCode?: string; verificationUrl?: string; expiresInSeconds?: number }) => void;
  const notifyPromise = new Promise<{ userCode?: string; verificationUrl?: string; expiresInSeconds?: number }>(
    (resolve) => {
      notifyResolve = resolve;
    },
  );

  const interaction = createOAuthInteractionShim(
    {
      signal: abortController.signal,
      onBrowserOpen: (url) => {
        notifyResolve({
          verificationUrl: url,
          expiresInSeconds: 600,
        });
      },
      onDeviceCode: (info) => {
        notifyResolve({
          userCode: info.userCode,
          verificationUrl: info.verificationUrl,
          expiresInSeconds: Math.round(info.expiresInMs / 1000),
        });
      },
    },
    abortController.signal,
  );

  const loginPromise = flow.login(interaction as any);
  const loginErrorPromise = new Promise<{ userCode?: string; verificationUrl?: string; expiresInSeconds?: number }>(
    (_, reject) => {
      loginPromise.catch((err) => reject(err));
    },
  );
  // Attach a no-op handler so background rejection doesn't trigger unhandledRejection
  loginPromise.catch(() => {});

  // Wait for notify event (up to 15s) or early login failure
  const timeoutPromise = new Promise<{ userCode?: string; verificationUrl?: string; expiresInSeconds?: number }>(
    (resolve) => setTimeout(() => resolve({}), 15_000),
  );

  let notified: { userCode?: string; verificationUrl?: string; expiresInSeconds?: number };
  try {
    notified = await Promise.race([notifyPromise, loginErrorPromise, timeoutPromise]);
  } catch (err: any) {
    sendError(res, 400, "OAUTH_FLOW_ERROR", redactString(err?.message || "OAuth login flow initiation failed"));
    return;
  }

  const expiresInMs = (notified?.expiresInSeconds ?? 600) * 1000;
  const userCode = notified?.userCode;
  const verificationUrl = notified?.verificationUrl;

  pendingOAuthAttempts.set(attemptId, {
    attemptId,
    providerId,
    upstream,
    createdAt: Date.now(),
    expiresAt: Date.now() + expiresInMs,
    userCode,
    verificationUrl,
    loginPromise,
    abortController,
  });

  sendJSON(res, 200, {
    attemptId,
    userCode,
    verificationUrl,
    expiresInMs,
  });
}

export async function handleOAuthComplete(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: ProviderRuntime,
  key: ApiKeyEntry,
  providerId: string,
): Promise<void> {
  if (!checkDeploymentMode(res)) return;
  if (!hasScope(key, "provider:admin")) {
    sendError(res, 403, "FORBIDDEN", "API key lacks 'provider:admin' scope");
    return;
  }

  let bodyText: string;
  try {
    bodyText = await parseBody(req);
  } catch {
    sendError(res, 400, "BAD_REQUEST", "Failed to read request body");
    return;
  }

  let body: any;
  try {
    body = JSON.parse(bodyText);
  } catch {
    sendError(res, 400, "BAD_REQUEST", "Invalid JSON in request body");
    return;
  }

  const { attemptId } = body;
  if (!attemptId || !pendingOAuthAttempts.has(attemptId)) {
    sendError(res, 400, "OAUTH_ATTEMPT_NOT_FOUND", "OAuth attempt expired or not found");
    return;
  }

  const attempt = pendingOAuthAttempts.get(attemptId)!;
  if (attempt.providerId !== providerId) {
    sendError(res, 400, "OAUTH_PROVIDER_MISMATCH", `Attempt was initiated for "${attempt.providerId}", not "${providerId}"`);
    return;
  }

  if (Date.now() > attempt.expiresAt) {
    attempt.abortController?.abort();
    pendingOAuthAttempts.delete(attemptId);
    sendError(res, 400, "OAUTH_EXPIRED", "OAuth authorization expired");
    return;
  }

  try {
    let timerId: any;
    const timeoutPromise = new Promise((_, reject) => {
      timerId = setTimeout(() => reject(new Error("OAUTH_PENDING")), 5000);
    });
    const credResult: any = await Promise.race([attempt.loginPromise, timeoutPromise]).finally(() => {
      if (timerId) clearTimeout(timerId);
    });

    const api = createProviderManagerApi(runtime);
    const saveRes = await api.completeOAuthSignIn(
      attempt.upstream,
      {
        access: credResult.access,
        refresh: credResult.refresh,
        expires: credResult.expires,
      },
      {
        preferredAccountId: providerId,
        description: `OAuth login for ${attempt.upstream}`,
      },
    );

    pendingOAuthAttempts.delete(attemptId);
    if (!saveRes.ok) {
      sendError(res, 400, saveRes.error.code.toUpperCase(), saveRes.error.message);
      return;
    }

    sendJSON(
      res,
      200,
      {
        revision: saveRes.state.revision,
        provider: {
          id: providerId,
          adapter: "pi-ai",
          upstreamProvider: attempt.upstream,
          credential: { kind: "redacted" },
        },
      },
      saveRes.state.revision,
    );
  } catch (err: any) {
    if (err.message === "OAUTH_PENDING") {
      sendError(res, 202, "OAUTH_PENDING", "Authorization still pending in browser");
      return;
    }
    pendingOAuthAttempts.delete(attemptId);
    sendError(res, 400, "OAUTH_FAILED", redactString(err?.message || "OAuth login failed"));
  }
}
