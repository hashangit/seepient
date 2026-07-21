/**
 * Seepient Server — Gateway REST Route Handlers
 *
 * Handles all /v1/gateway/* REST endpoints for target management,
 * audit logs, usage summaries, credentials, routes, and OpenAPI imports.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { authMiddleware, hasScope } from "../auth/auth.js";

import type { MCPGateway } from "../../capabilities/gateway/gateway.js";
import type { GatewaySettingsAdapter } from "../../capabilities/gateway/settings-adapter.js";
import type { importOpenApiSpec } from "../../capabilities/gateway/openapi-importer.js";

/** Signature of the capability's OpenAPI importer, injected by the composition root. */
export type ImportOpenApiSpec = typeof importOpenApiSpec;

// ── Helpers ────────────────────────────────────────────────────────────

function sendJSON(res: ServerResponse, statusCode: number, data: unknown): void {
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

async function parseJsonBody<T>(req: IncomingMessage, res: ServerResponse): Promise<T | null> {
  let body: T;
  try {
    body = JSON.parse(await parseBody(req));
  } catch {
    sendError(res, 400, "BAD_REQUEST", "Invalid JSON in request body");
    return null;
  }
  return body;
}

function requireAuth(
  req: IncomingMessage,
  res: ServerResponse,
  scope: "agent:read" | "admin",
): boolean {
  const key = authMiddleware(req);
  if (!key) {
    sendError(res, 401, "UNAUTHORIZED", "Missing or invalid API key");
    return false;
  }
  if (!hasScope(key, scope)) {
    sendError(res, 403, "FORBIDDEN", `API key lacks '${scope}' scope`);
    return false;
  }
  return true;
}

// ── Route matching ─────────────────────────────────────────────────────

type GatewayRoute =
  | { handler: "list_targets" }
  | { handler: "audit" }
  | { handler: "usage" }
  | { handler: "register_target" }
  | { handler: "toggle_target"; name: string }
  | { handler: "unregister_target"; name: string }
  | { handler: "get_credentials" }
  | { handler: "put_credential"; key: string }
  | { handler: "add_route" }
  | { handler: "import_openapi" };

function matchGatewayRoute(
  path: string,
  method: string,
): GatewayRoute | null {
  if (method === "GET" && path === "/v1/gateway/targets") {
    return { handler: "list_targets" };
  }
  if (method === "GET" && path === "/v1/gateway/audit") {
    return { handler: "audit" };
  }
  if (method === "GET" && path === "/v1/gateway/usage") {
    return { handler: "usage" };
  }
  if (method === "POST" && path === "/v1/gateway/targets") {
    return { handler: "register_target" };
  }
  const toggleMatch = path.match(/^\/v1\/gateway\/targets\/([^/]+)\/toggle$/);
  if (method === "PATCH" && toggleMatch) {
    return { handler: "toggle_target", name: decodeURIComponent(toggleMatch[1]) };
  }
  const targetDeleteMatch = path.match(/^\/v1\/gateway\/targets\/([^/]+)$/);
  if (method === "DELETE" && targetDeleteMatch) {
    return { handler: "unregister_target", name: decodeURIComponent(targetDeleteMatch[1]) };
  }
  if (method === "GET" && path === "/v1/gateway/credentials") {
    return { handler: "get_credentials" };
  }
  const credMatch = path.match(/^\/v1\/gateway\/credentials\/(.+)$/);
  if (method === "PUT" && credMatch) {
    return { handler: "put_credential", key: decodeURIComponent(credMatch[1]) };
  }
  if (method === "POST" && path === "/v1/gateway/routes") {
    return { handler: "add_route" };
  }
  if (method === "POST" && path === "/v1/gateway/import-openapi") {
    return { handler: "import_openapi" };
  }

  return null;
}

// ── Main handler factory ───────────────────────────────────────────────

export function createGatewayRestHandler(ctx: {
  gateway: MCPGateway;
  settingsAdapter: GatewaySettingsAdapter;
  /** Injected by the composition root — the handler never imports the capability runtime. */
  importOpenApiSpec: ImportOpenApiSpec;
}): (req: IncomingMessage, res: ServerResponse, path: string, method: string) => Promise<void> {
  const { gateway, settingsAdapter, importOpenApiSpec } = ctx;

  return async function handleGatewayRoute(
    req: IncomingMessage,
    res: ServerResponse,
    urlPath: string,
    method: string,
  ): Promise<void> {
    const route = matchGatewayRoute(urlPath, method);

    if (!route) {
      sendError(res, 404, "NOT_FOUND", `No gateway route for ${method} ${urlPath}`);
      return;
    }

    try {
      switch (route.handler) {
        case "list_targets": {
          if (!requireAuth(req, res, "agent:read")) return;
          sendJSON(res, 200, { targets: gateway.getTargets() });
          break;
        }
        case "audit": {
          if (!requireAuth(req, res, "agent:read")) return;
          sendJSON(res, 200, { logs: gateway.getAuditLogs() });
          break;
        }
        case "usage": {
          if (!requireAuth(req, res, "agent:read")) return;
          sendJSON(res, 200, { usage: gateway.getUsageSummary() });
          break;
        }
        case "register_target": {
          if (!requireAuth(req, res, "admin")) return;
          const body = await parseJsonBody<{ name: string; target: import("../../capabilities/gateway/types.js").Target }>(req, res);
          if (!body) return;
          if (!body.name || !body.target) {
            sendError(res, 400, "BAD_REQUEST", "Fields 'name' and 'target' are required");
            return;
          }
          await gateway.registerTarget(body.name, body.target, true);
          sendJSON(res, 201, { ok: true });
          break;
        }
        case "toggle_target": {
          if (!requireAuth(req, res, "admin")) return;
          const body = await parseJsonBody<{ enabled: boolean }>(req, res);
          if (!body) return;
          if (typeof body.enabled !== "boolean") {
            sendError(res, 400, "BAD_REQUEST", "Field 'enabled' must be a boolean");
            return;
          }
          const ok = await gateway.toggleTarget(route.name, body.enabled);
          if (!ok) {
            sendError(res, 404, "NOT_FOUND", `Target '${route.name}' not found`);
            return;
          }
          sendJSON(res, 200, { ok: true });
          break;
        }
        case "unregister_target": {
          if (!requireAuth(req, res, "admin")) return;
          const deleted = await gateway.unregisterTarget(route.name);
          if (!deleted) {
            sendError(res, 404, "NOT_FOUND", `Target '${route.name}' not found`);
            return;
          }
          sendJSON(res, 200, { ok: true });
          break;
        }
        case "get_credentials": {
          if (!requireAuth(req, res, "admin")) return;
          sendJSON(res, 200, { keys: settingsAdapter.listCredentialKeys() });
          break;
        }
        case "put_credential": {
          if (!requireAuth(req, res, "admin")) return;
          const body = await parseJsonBody<{ value: string }>(req, res);
          if (!body) return;
          if (!body.value) {
            sendError(res, 400, "BAD_REQUEST", "Field 'value' is required");
            return;
          }
          await settingsAdapter.setCredential(route.key, body.value);
          sendJSON(res, 200, { ok: true });
          break;
        }
        case "add_route": {
          if (!requireAuth(req, res, "admin")) return;
          const body = await parseJsonBody<{ pattern: string; target: string; priority?: number }>(req, res);
          if (!body) return;
          if (!body.pattern || !body.target) {
            sendError(res, 400, "BAD_REQUEST", "Fields 'pattern' and 'target' are required");
            return;
          }
          await gateway.addRoute(body.pattern, body.target, body.priority ?? 0);
          sendJSON(res, 201, { ok: true });
          break;
        }
        case "import_openapi": {
          if (!requireAuth(req, res, "admin")) return;
          const body = await parseJsonBody<{ name: string; specUrl: string; baseUrl?: string }>(req, res);
          if (!body) return;
          if (!body.name || !body.specUrl) {
            sendError(res, 400, "BAD_REQUEST", "Fields 'name' and 'specUrl' are required");
            return;
          }
          const { importOpenApiSpec } = await import("../../capabilities/gateway/openapi-importer.js");
          const result = await importOpenApiSpec(
            gateway,
            body.name,
            body.specUrl,
            { baseUrl: body.baseUrl, isAdmin: true },
          );
          sendJSON(res, 201, result);
          break;
        }
        default:
          sendError(res, 404, "NOT_FOUND", "Unknown gateway endpoint");
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Gateway request failed";
      console.error("[rest-gateway] Error:", message);
      sendError(res, 500, "INTERNAL_ERROR", message);
    }
  };
}
