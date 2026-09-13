/**
 * Stub Embedder Control Plane Application (Spec 021, FR-011, QS-4).
 *
 * Implements HTTP endpoints for tenant state storage and approval relays:
 * - POST /api/audit — Action audit event storage
 * - GET/POST /api/policy — Policy snapshot read / compareAndSet
 * - GET/POST /api/caps — Capability consumption and revocations
 * - GET/POST /api/sessions — Session data persistence
 * - POST /api/approvals — Interactive tool approval relay
 */

import * as http from "node:http";
import * as crypto from "node:crypto";
import type {
  ActionAuditEvent,
  PolicySnapshot,
  CapabilitySet,
  SessionData,
  RevokeFilter,
  PermissionRequest,
  PermissionDecision,
} from "../../../src/transport/sdk/index.js";

export const KNOWN_TOKENS: Record<string, string> = {
  "token-tenant-a": "tenant-a",
  "token-tenant-b": "tenant-b",
  "token-user-123": "user-123",
  "token-tenant-abc": "tenant-abc",
};

export class ScopedSessionMap extends Map<string, SessionData> {
  // Exact match only - suffix matching is removed to prevent cross-principal session context poisoning (P1-F)
}

export interface StubAppState {
  adminSecret: string;
  auditEvents: { event: ActionAuditEvent; idempotencyKey: string; principalId?: string }[];
  policySnapshots: Map<string, PolicySnapshot>;
  consumedDigests: Set<string>;
  revocations: Array<RevokeFilter & { principalId?: string }>;
  sessions: Map<string, SessionData>;
  approvalRequests: PermissionRequest[];
  approvalDecision: boolean;
  skills: Array<{ id: string; name: string; content: string; tenant_id: string | null; source?: string }>;
  tokenToPrincipal: Map<string, string>;
}

export function isForbiddenWildcardCapability(cap: any): boolean {
  if (!cap || typeof cap !== "object") return true;
  switch (cap.kind) {
    case "write-root":
    case "read-root":
      return !cap.root || cap.root === "*" || cap.root === "/";
    case "network-destination":
      return !cap.host || cap.host === "*" || cap.destination === "*" || cap.domain === "*";
    case "external-recipient":
      return (
        !cap.recipient ||
        cap.recipient === "*" ||
        !cap.service ||
        cap.service === "*" ||
        cap.domain === "*"
      );
    case "process":
      return (
        !cap.executable ||
        cap.executable === "*" ||
        cap.binary === "*" ||
        cap.command === "*"
      );
    case "secret-ref":
      return !cap.ref || cap.ref === "*";
    case "model-egress":
      return (
        !cap.providerClass ||
        cap.providerClass === "*" ||
        !Array.isArray(cap.dataClasses) ||
        cap.dataClasses.includes("*") ||
        cap.dataClasses.includes("secret")
      );
    case "trusted-host":
      return !cap.registrationId || cap.registrationId === "*";
    default:
      return false;
  }
}

export function createStubApp(initialState?: Partial<StubAppState> & { allowDemoTokens?: boolean }): {
  server: http.Server;
  state: StubAppState;
  listen: () => Promise<number>;
  close: () => Promise<void>;
} {
  const initialTokens = new Map<string, string>(
    initialState?.allowDemoTokens ? Object.entries(KNOWN_TOKENS) : [],
  );
  if (initialState?.tokenToPrincipal) {
    for (const [t, p] of initialState.tokenToPrincipal.entries()) {
      initialTokens.set(t, p);
    }
  }

  const state: StubAppState = {
    adminSecret: initialState?.adminSecret ?? process.env.CONTROL_PLANE_ADMIN_KEY ?? "",
    auditEvents: [],
    policySnapshots: new Map([
      [
        "default",
        {
          workspaceId: "default",
          version: 1,
          policyDigest: "digest-default",
          policy: { version: 1, capabilities: [{ kind: "write-root", root: "*" }] },
          mutationHistory: [],
        },
      ],
    ]),
    consumedDigests: new Set(),
    revocations: [],
    sessions: new ScopedSessionMap(),
    approvalRequests: [],
    approvalDecision: true,
    skills: [],
    ...initialState,
    tokenToPrincipal: initialTokens,
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const MAX_BODY_BYTES = 1024 * 1024; // 1MB body limit (NEW-2)
    let body = "";
    let tooLarge = false;
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        tooLarge = true;
        req.destroy();
      }
    });
    await new Promise<void>((resolve) => req.on("end", () => resolve()));
    if (tooLarge) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "PayloadTooLarge", message: "Request body exceeds 1MB limit" }));
      return;
    }

    let jsonBody: any = {};
    if (body) {
      try {
        jsonBody = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "BadRequest", message: "Invalid JSON body" }));
        return;
      }
    }

    // Token issuance endpoint (P0-W1 / NEW-5)
    if (req.method === "POST" && url.pathname === "/api/auth/token") {
      if (!state.adminSecret) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "ServiceUnavailable", message: "CONTROL_PLANE_ADMIN_KEY is not configured; token issuance disabled" }));
        return;
      }
      const adminKey = req.headers["x-admin-key"];
      const adminKeyBuf = Buffer.from(typeof adminKey === "string" ? adminKey : "");
      const secretBuf = Buffer.from(state.adminSecret);
      const authorized = adminKeyBuf.length === secretBuf.length && crypto.timingSafeEqual(adminKeyBuf, secretBuf);
      if (!authorized) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Forbidden", message: "Admin authorization required for token issuance" }));
        return;
      }
      const principalId = jsonBody.principalId;
      if (!principalId || typeof principalId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(principalId)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "BadRequest", message: "Invalid or missing principalId slug" }));
        return;
      }
      const sentinels = new Set(["default", "anonymous", "sdk-user", "cli-user"]);
      if (sentinels.has(principalId.toLowerCase())) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "BadRequest", message: "Sentinel principalId cannot be issued" }));
        return;
      }
      const token = "token-" + crypto.randomUUID();
      state.tokenToPrincipal.set(token, principalId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ token, principalId }));
      return;
    }

    // FR-018 / VULN-19: All control plane endpoints require Bearer authentication
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized", message: "Bearer authentication required" }));
      return;
    }
    const token = authHeader.slice(7).trim();
    if (!token) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized", message: "Bearer token required" }));
      return;
    }

    const authPrincipal = state.tokenToPrincipal.get(token);
    if (!authPrincipal) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized", message: "Invalid or unknown token" }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/audit") {
      const isDuplicate = state.auditEvents.some(
        (e) => e.principalId === authPrincipal && e.idempotencyKey === jsonBody.idempotencyKey,
      );
      if (isDuplicate) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "duplicate" }));
        return;
      }
      state.auditEvents.push({ ...jsonBody, principalId: authPrincipal });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "written" }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/policy") {
      const workspaceId = url.searchParams.get("workspaceId") ?? "default";
      const principalId = authPrincipal;
      const key = `${workspaceId}:${principalId}`;
      let snapshot = state.policySnapshots.get(key);
      if (!snapshot && principalId) {
        const wsSnapshot = state.policySnapshots.get(workspaceId);
        if (wsSnapshot) {
          // P1-D / P1-E: Never return unstamped workspace wildcards; filter strictly for principalId
          const filtered = wsSnapshot.policy.capabilities.filter((cap) => {
            return cap.principalId === principalId;
          });
          snapshot = {
            ...wsSnapshot,
            policy: {
              ...wsSnapshot.policy,
              capabilities: filtered,
            },
          };
        }
      }
      if (!snapshot) {
        snapshot = {
          workspaceId,
          version: 0,
          policyDigest: "empty",
          policy: { version: 1, capabilities: [] },
          mutationHistory: [],
        };
      }
      // Ensure returned capabilities are strictly scoped to authPrincipal (P1-A / P1-D)
      const safeCapabilities = snapshot.policy.capabilities.filter((cap) => cap.principalId === principalId);
      const safeSnapshot: PolicySnapshot = {
        ...snapshot,
        policy: {
          ...snapshot.policy,
          capabilities: safeCapabilities,
        },
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(safeSnapshot));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/policy") {
      const { workspaceId, expectedVersion, next, actor, mutation } = jsonBody;
      const principalId = authPrincipal;
      const key = `${workspaceId}:${principalId}`;
      const current = state.policySnapshots.get(key) ?? {
        workspaceId,
        version: 0,
        policyDigest: "empty",
        policy: { version: 1, capabilities: [] },
        mutationHistory: [],
      };
      if (current.version !== expectedVersion) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "VersionConflict", current }));
        return;
      }
      // P1-D / P1-E: Capabilities must be stamped with authPrincipal; no wildcards
      const capabilities = Array.isArray(next?.capabilities) ? next.capabilities : [];
      for (const cap of capabilities) {
        if (!cap || cap.principalId !== principalId) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Forbidden", message: "Capabilities must be stamped with authenticated principalId" }));
          return;
        }
        if (isForbiddenWildcardCapability(cap)) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Forbidden", message: `Wildcard ${cap.kind} is forbidden in multi-tenant policy` }));
          return;
        }
      }
      const updated: PolicySnapshot = {
        workspaceId,
        version: expectedVersion + 1,
        policyDigest: `digest-${expectedVersion + 1}`,
        policy: {
          ...next,
          capabilities,
        },
        mutationHistory: [
          ...(current.mutationHistory ?? []),
          ...(mutation ? [{ mutationId: mutation.mutationId, version: expectedVersion + 1 }] : []),
        ],
      };
      state.policySnapshots.set(key, updated);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(updated));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/caps") {
      const prefix = `${authPrincipal}:`;
      const tenantDigests = Array.from(state.consumedDigests)
        .filter((d) => d.startsWith(prefix))
        .map((d) => d.slice(prefix.length));
      const tenantRevocations = state.revocations
        .filter((r) => r.principalId === authPrincipal)
        .map(({ runId, sessionId }) => ({ runId, sessionId }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        consumedDigests: tenantDigests,
        revocations: tenantRevocations,
      }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/caps/consume") {
      const scopedDigest = `${authPrincipal}:${jsonBody.actionDigest}`;
      if (state.consumedDigests.has(scopedDigest)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, consumed: false }));
        return;
      }
      state.consumedDigests.add(scopedDigest);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, consumed: true }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/caps/revoke") {
      state.revocations.push({
        ...(jsonBody.filter ?? {}),
        principalId: authPrincipal,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/sessions") {
      const sessionId = url.searchParams.get("sessionId");
      if (sessionId) {
        const session = state.sessions.get(`${authPrincipal}:${sessionId}`) ?? null;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(session));
      } else {
        const prefix = `${authPrincipal}:`;
        const scopedKeys = Array.from(state.sessions.keys())
          .filter((k) => k.startsWith(prefix))
          .map((k) => k.slice(prefix.length));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(scopedKeys));
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/sessions") {
      const compositeKey = `${authPrincipal}:${jsonBody.id}`;
      state.sessions.set(compositeKey, jsonBody.data);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === "DELETE" && url.pathname === "/api/sessions") {
      const sessionId = url.searchParams.get("sessionId");
      if (sessionId) {
        state.sessions.delete(`${authPrincipal}:${sessionId}`);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/approvals") {
      state.approvalRequests.push(jsonBody);
      const decision: PermissionDecision = state.approvalDecision
        ? {
            approved: true,
            requestId: jsonBody.requestId,
            actionDigest: jsonBody.actionDigest,
            optionId: jsonBody.approvalChoices?.[0]?.optionId ?? jsonBody.approvalOptions?.[0]?.optionId ?? "opt-1",
            lifetime: jsonBody.approvalChoices?.[0]?.lifetime ?? "action",
            actorId: "stub-control-plane",
            decidedAt: Date.now(),
          }
        : {
            approved: false,
            requestId: jsonBody.requestId,
            actionDigest: jsonBody.actionDigest,
            actorId: "stub-control-plane",
            reason: "Rejected by stub control plane",
            decidedAt: Date.now(),
          };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(decision));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/skills") {
      const tenantId = url.searchParams.get("tenantId");
      if (tenantId && tenantId !== authPrincipal) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Forbidden", message: "Cannot query skills for other tenants" }));
        return;
      }
      const matched = state.skills.filter((s) =>
        tenantId ? s.tenant_id === tenantId : s.tenant_id === null,
      );
      const records = matched.map((s) => ({
        name: s.name,
        content: s.content,
        source: s.source ?? (tenantId ? `db:tenant:${tenantId}` : "db:global"),
      }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ skills: records }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/skills") {
      state.skills.push({
        ...jsonBody,
        tenant_id: authPrincipal,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  return {
    server,
    state,
    listen: async () => {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      return (server.address() as { port: number }).port;
    },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
