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
import type {
  ActionAuditEvent,
  PolicySnapshot,
  CapabilitySet,
  SessionData,
  RevokeFilter,
  PermissionRequest,
  PermissionDecision,
} from "../../../src/transport/sdk/index.js";

export interface StubAppState {
  auditEvents: { event: ActionAuditEvent; idempotencyKey: string }[];
  policySnapshots: Map<string, PolicySnapshot>;
  consumedDigests: Set<string>;
  revocations: RevokeFilter[];
  sessions: Map<string, SessionData>;
  approvalRequests: PermissionRequest[];
  approvalDecision: boolean;
}

export function createStubApp(initialState?: Partial<StubAppState>): {
  server: http.Server;
  state: StubAppState;
  listen: () => Promise<number>;
  close: () => Promise<void>;
} {
  const state: StubAppState = {
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
    sessions: new Map(),
    approvalRequests: [],
    approvalDecision: true,
    ...initialState,
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    await new Promise<void>((resolve) => req.on("end", () => resolve()));

    const jsonBody = body ? JSON.parse(body) : {};

    if (req.method === "POST" && url.pathname === "/api/audit") {
      const isDuplicate = state.auditEvents.some((e) => e.idempotencyKey === jsonBody.idempotencyKey);
      if (isDuplicate) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "duplicate" }));
        return;
      }
      state.auditEvents.push(jsonBody);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "written" }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/policy") {
      const workspaceId = url.searchParams.get("workspaceId") ?? "default";
      const snapshot = state.policySnapshots.get(workspaceId);
      if (!snapshot) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "PolicyNotFound" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(snapshot));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/policy") {
      const { workspaceId, expectedVersion, next, actor, mutation } = jsonBody;
      const current = state.policySnapshots.get(workspaceId) ?? {
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
      const updated: PolicySnapshot = {
        workspaceId,
        version: expectedVersion + 1,
        policyDigest: `digest-${expectedVersion + 1}`,
        policy: next,
        mutationHistory: [
          ...(current.mutationHistory ?? []),
          ...(mutation ? [{ mutationId: mutation.mutationId, version: expectedVersion + 1 }] : []),
        ],
      };
      state.policySnapshots.set(workspaceId, updated);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(updated));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/caps") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        consumedDigests: Array.from(state.consumedDigests),
        revocations: state.revocations,
      }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/caps/consume") {
      if (state.consumedDigests.has(jsonBody.actionDigest)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, consumed: false }));
        return;
      }
      state.consumedDigests.add(jsonBody.actionDigest);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, consumed: true }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/caps/revoke") {
      state.revocations.push(jsonBody.filter);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/sessions") {
      const sessionId = url.searchParams.get("sessionId");
      if (sessionId) {
        const session = state.sessions.get(sessionId) ?? null;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(session));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(Array.from(state.sessions.keys())));
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/sessions") {
      state.sessions.set(jsonBody.id, jsonBody.data);
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
