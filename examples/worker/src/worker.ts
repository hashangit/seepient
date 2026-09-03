/**
 * Reference Stateless Worker (Spec 021, FR-011, QS-4).
 *
 * Demonstrates:
 * 1. Embedding the Seepient SDK in a container / microVM worker.
 * 2. Injected tenant state stores (AuditStore, PolicyStore, CapabilityLedger, PersistenceBackend)
 *    connecting to an embedder control plane over HTTP.
 * 3. Brokered tool execution + permission-gated tool execution with approval relay.
 * 4. Zero persistent local state on the worker filesystem.
 */

import {
  createAgent,
  type AuditStore,
  type PolicyStore,
  type CapabilityLedger,
  type ActionAuditEvent,
  type PolicySnapshot,
  type CapabilitySet,
  type DecisionAuthority,
  type PersistenceBackend,
  type SessionData,
  type SdkAgent,
  type ProviderRuntime,
  type RevokeFilter,
  type ConsentMode,
  type ApprovalBroker,
  type PermissionRequest,
  type PermissionDecision,
} from "../../../src/transport/sdk/index.js";

/**
 * Worker configuration passed by the embedder on task start.
 */
export interface WorkerTaskConfig {
  tenantId: string;
  principalId: string;
  sessionId: string;
  workspaceDir: string;
  runtime: ProviderRuntime;
  controlPlaneUrl: string;
  auditStore?: AuditStore;
  policyStore?: PolicyStore;
  capabilityLedger?: CapabilityLedger;
  persistence?: PersistenceBackend;
  consentMode?: ConsentMode;
  relayApproval?: (req: PermissionRequest) => Promise<PermissionDecision>;
}

/**
 * HTTP-backed audit store adapter for embedder.
 * Enforces pre-dispatch durability: throws if remote write fails.
 */
export class RemoteAuditStore implements AuditStore {
  readonly events: ActionAuditEvent[] = [];
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    if (!baseUrl) {
      throw new Error("[worker-audit] controlPlaneUrl is required for RemoteAuditStore");
    }
    this.baseUrl = baseUrl;
  }

  async append(
    event: ActionAuditEvent,
    opts: { idempotencyKey: string },
  ): Promise<"written" | "duplicate"> {
    const res = await fetch(`${this.baseUrl}/api/audit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, idempotencyKey: opts.idempotencyKey }),
    });
    if (!res.ok) {
      throw new Error(`[worker-audit] Remote audit store failed with HTTP ${res.status}`);
    }
    const data = (await res.json()) as { status?: "written" | "duplicate" };
    if (data.status === "duplicate") {
      return "duplicate";
    }
    this.events.push(event);
    return "written";
  }

  async getTerminal(actionId: string): Promise<ActionAuditEvent | undefined> {
    return this.events.find((e) => e.actionId === actionId);
  }
}

/**
 * HTTP-backed policy store adapter for embedder.
 */
export class RemotePolicyStore implements PolicyStore {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    if (!baseUrl) {
      throw new Error("[worker-policy] controlPlaneUrl is required for RemotePolicyStore");
    }
    this.baseUrl = baseUrl;
  }

  async read(workspaceId: string): Promise<PolicySnapshot> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/policy?workspaceId=${encodeURIComponent(workspaceId)}`);
    } catch (err) {
      throw new Error(`[worker-policy] Policy read failed for workspace ${workspaceId}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.ok) {
      return (await res.json()) as PolicySnapshot;
    }
    throw new Error(`[worker-policy] Policy read failed for workspace ${workspaceId}: HTTP ${res.status}`);
  }

  async compareAndSet(
    workspaceId: string,
    expectedVersion: number,
    next: CapabilitySet,
    actor: DecisionAuthority,
    mutation?: { mutationId: string },
  ): Promise<PolicySnapshot> {
    const res = await fetch(`${this.baseUrl}/api/policy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId, expectedVersion, next, actor, mutation }),
    });
    if (res.ok) {
      return (await res.json()) as PolicySnapshot;
    }
    throw new Error(`[worker-policy] compareAndSet failed: HTTP ${res.status}`);
  }
}

/**
 * HTTP-backed capability ledger adapter for embedder.
 */
export class RemoteCapabilityLedger implements CapabilityLedger {
  private readonly baseUrl: string;
  private readonly consumedDigests = new Set<string>();
  private readonly revocations: RevokeFilter[] = [];

  constructor(baseUrl: string) {
    if (!baseUrl) {
      throw new Error("[worker-caps] controlPlaneUrl is required for RemoteCapabilityLedger");
    }
    this.baseUrl = baseUrl;
  }

  async load(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/caps`);
    if (res.ok) {
      const data = (await res.json()) as { consumedDigests?: string[]; revocations?: RevokeFilter[] };
      for (const d of data.consumedDigests ?? []) this.consumedDigests.add(d);
      for (const r of data.revocations ?? []) this.revocations.push(r);
      return;
    }
    throw new Error(`[worker-caps] Capability sync failed: HTTP ${res.status}`);
  }

  async consume(envelopeId: string, actionDigest: string): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/api/caps/consume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ envelopeId, actionDigest }),
    });
    if (!res.ok) {
      throw new Error(`[worker-caps] Capability consume failed: HTTP ${res.status}`);
    }
    const data = (await res.json()) as { ok: boolean; consumed?: boolean };
    if (data.consumed === false) {
      return false;
    }
    this.consumedDigests.add(actionDigest);
    return true;
  }

  async revoke(filter: RevokeFilter): Promise<void> {
    this.revocations.push(filter);
    const res = await fetch(`${this.baseUrl}/api/caps/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filter }),
    });
    if (!res.ok) {
      throw new Error(`[worker-caps] Capability revoke failed: HTTP ${res.status}`);
    }
  }

  isConsumedDigest(actionDigest: string): boolean {
    return this.consumedDigests.has(actionDigest);
  }

  isRunRevoked(runId: string): boolean {
    return this.revocations.some((r) => r.runId === runId);
  }

  isSessionRevoked(sessionId: string): boolean {
    return this.revocations.some((r) => r.sessionId === sessionId);
  }
}

/**
 * HTTP-backed session persistence backend adapter for embedder.
 */
export class RemotePersistenceBackend implements PersistenceBackend {
  readonly __persistenceBackend = true as const;
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    if (!baseUrl) {
      throw new Error("[worker-persistence] controlPlaneUrl is required for RemotePersistenceBackend");
    }
    this.baseUrl = baseUrl;
  }

  async save(id: string, data: SessionData): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, data }),
    });
    if (!res.ok) {
      throw new Error(`[worker-persistence] Session save failed: HTTP ${res.status}`);
    }
  }

  async load(id: string): Promise<SessionData | null> {
    const res = await fetch(`${this.baseUrl}/api/sessions?sessionId=${encodeURIComponent(id)}`);
    if (res.ok) {
      return (await res.json()) as SessionData | null;
    }
    return null;
  }

  async delete(id: string): Promise<void> {
    await fetch(`${this.baseUrl}/api/sessions?sessionId=${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async list(): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/api/sessions`);
    if (res.ok) {
      return (await res.json()) as string[];
    }
    return [];
  }
}

/**
 * Create and configure a tenant-scoped worker agent instance.
 */
export async function createWorkerAgent(config: WorkerTaskConfig): Promise<SdkAgent> {
  if (!config.controlPlaneUrl && (!config.auditStore || !config.policyStore || !config.capabilityLedger)) {
    throw new Error("[worker] controlPlaneUrl is required when external stores are not explicitly provided");
  }
  const auditStore = config.auditStore ?? new RemoteAuditStore(config.controlPlaneUrl);
  const policyStore = config.policyStore ?? new RemotePolicyStore(config.controlPlaneUrl);
  const capabilityLedger = config.capabilityLedger ?? new RemoteCapabilityLedger(config.controlPlaneUrl);
  const persistence = config.persistence ?? (config.controlPlaneUrl ? new RemotePersistenceBackend(config.controlPlaneUrl) : undefined);

  const agent = await createAgent({
    principalId: config.principalId,
    sessionId: config.sessionId,
    cwd: config.workspaceDir,
    runtime: config.runtime,
    auditStore,
    policyStore,
    capabilityLedger,
    persist: persistence,
    consentMode: config.consentMode ?? "ask-everything",
    approvalBroker: {
      mode: "callback",
      request: async (req: PermissionRequest) => {
        if (config.relayApproval) {
          return config.relayApproval(req);
        }
        if (config.controlPlaneUrl) {
          const res = await fetch(`${config.controlPlaneUrl}/api/approvals`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(req),
          });
          if (res.ok) {
            return (await res.json()) as PermissionDecision;
          }
        }
        return {
          approved: false,
          requestId: req.requestId,
          actionDigest: req.actionDigest,
          actorId: "worker-fail-closed",
          reason: "Approval mechanism unavailable",
          decidedAt: Date.now(),
        };
      },
    },
  });

  return agent;
}
