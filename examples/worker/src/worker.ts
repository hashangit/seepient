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
  createSeepient,
  type AuditStore,
  type PolicyStore,
  type CapabilityLedger,
  type ActionAuditEvent,
  type PolicySnapshot,
  type CapabilitySet,
  type DecisionAuthority,
  type PersistenceBackend,
  type SessionData,
  type Seepient,
  type ProviderRuntime,
  type RevokeFilter,
  type ConsentMode,
  type ApprovalBroker,
  type PermissionRequest,
  type PermissionDecision,
  type  SkillSource,
  FsSkillSources,
  SeepientError,
} from "../../../src/transport/sdk/index.js";

export class ControlPlaneTokenRequiredError extends SeepientError {
  constructor(message = "[worker] controlPlaneToken is required to interact with control plane") {
    super(message, "CONTROL_PLANE_TOKEN_REQUIRED", false);
    this.name = "ControlPlaneTokenRequiredError";
  }
}

export { DbSkillSource } from "./db-skill-source.js";

export interface RemoteStoreOptions {
  controlPlaneToken?: string;
  token?: string;
  principalId?: string;
}

function resolveRemoteOpts(
  optionsOrTokenOrPrincipal?: RemoteStoreOptions | string,
  explicitPrincipalId?: string,
): { token: string; principalId?: string } {
  let token: string | undefined;
  let principalId: string | undefined = explicitPrincipalId;

  if (typeof optionsOrTokenOrPrincipal === "string") {
    token = optionsOrTokenOrPrincipal;
  } else if (optionsOrTokenOrPrincipal) {
    token = optionsOrTokenOrPrincipal.controlPlaneToken ?? optionsOrTokenOrPrincipal.token;
    principalId = optionsOrTokenOrPrincipal.principalId ?? explicitPrincipalId;
  }

  if (!token || token.trim().length === 0) {
    throw new ControlPlaneTokenRequiredError();
  }

  return { token, principalId };
}

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
  controlPlaneToken?: string;
  token?: string;
  tenancy?: "single" | "multi";
  auditStore?: AuditStore;
  policyStore?: PolicyStore;
  capabilityLedger?: CapabilityLedger;
  persistence?: PersistenceBackend;
  consentMode?: ConsentMode;
  relayApproval?: (req: PermissionRequest) => Promise<PermissionDecision>;
  commitHelper?: any;
  sources?: SkillSource[];
}

/**
 * HTTP-backed audit store adapter for embedder.
 * Enforces pre-dispatch durability: throws if remote write fails.
 */
export class RemoteAuditStore implements AuditStore {
  readonly isIsolated = true;
  readonly events: ActionAuditEvent[] = [];
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly principalId?: string;

  constructor(
    baseUrl: string,
    optionsOrToken?: RemoteStoreOptions | string,
    principalId?: string,
  ) {
    if (!baseUrl) {
      throw new Error("[worker-audit] controlPlaneUrl is required for RemoteAuditStore");
    }
    this.baseUrl = baseUrl;
    const resolved = resolveRemoteOpts(optionsOrToken, principalId);
    this.token = resolved.token;
    this.principalId = resolved.principalId;
  }

  async append(
    event: ActionAuditEvent,
    opts: { idempotencyKey: string },
  ): Promise<"written" | "duplicate"> {
    const res = await fetch(`${this.baseUrl}/api/audit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ event, idempotencyKey: opts.idempotencyKey, principalId: this.principalId }),
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
  readonly isIsolated = true;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly principalId?: string;

  constructor(
    baseUrl: string,
    optionsOrTokenOrPrincipal?: RemoteStoreOptions | string,
    principalId?: string,
  ) {
    if (!baseUrl) {
      throw new Error("[worker-policy] controlPlaneUrl is required for RemotePolicyStore");
    }
    this.baseUrl = baseUrl;
    const resolved = resolveRemoteOpts(optionsOrTokenOrPrincipal, principalId);
    this.token = resolved.token;
    this.principalId = resolved.principalId;
  }

  async read(
    workspaceId: string,
    opts?: { principalId?: string; tenancyMode?: "single" | "multi"; controlPlaneToken?: string },
  ): Promise<PolicySnapshot> {
    let res: Response;
    try {
      const params = new URLSearchParams({ workspaceId });
      const effPrincipal = opts?.principalId ?? this.principalId;
      if (effPrincipal) params.set("principalId", effPrincipal);
      if (opts?.tenancyMode) params.set("tenancyMode", opts.tenancyMode);
      const token = opts?.controlPlaneToken ?? this.token;
      res = await fetch(`${this.baseUrl}/api/policy?${params.toString()}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
    } catch (err) {
      throw new Error(`[worker-policy] Policy read failed for workspace ${workspaceId}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.ok) {
      return (await res.json()) as PolicySnapshot;
    }
    if (res.status === 404) {
      return {
        workspaceId,
        version: 0,
        policyDigest: "empty",
        policy: { version: 1, capabilities: [] },
        mutationHistory: [],
      };
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
    const principalId = this.principalId ?? next.capabilities?.find((c) => c.principalId)?.principalId;
    const res = await fetch(`${this.baseUrl}/api/policy`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ workspaceId, expectedVersion, next, actor, mutation, principalId }),
    });
    if (res.ok) {
      return (await res.json()) as PolicySnapshot;
    }
    if (res.status === 409) {
      // Typed conflict so the lifecycle's single-retry CAS loop fires instead
      // of surfacing an honest approval as approval-unavailable (pass-10 P2-2).
      const { PolicyConflictError } = await import(
        "../../../src/foundations/errors.js"
      );
      throw new PolicyConflictError(
        `[worker-policy] compareAndSet version conflict: HTTP ${res.status}`,
      );
    }
    throw new Error(`[worker-policy] compareAndSet failed: HTTP ${res.status}`);
  }
}

/**
 * HTTP-backed capability ledger adapter for embedder.
 */
export class RemoteCapabilityLedger implements CapabilityLedger {
  readonly isIsolated = true;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly principalId?: string;
  private readonly consumedDigests = new Set<string>();
  private readonly revocations: RevokeFilter[] = [];

  constructor(
    baseUrl: string,
    optionsOrToken?: RemoteStoreOptions | string,
    principalId?: string,
  ) {
    if (!baseUrl) {
      throw new Error("[worker-caps] controlPlaneUrl is required for RemoteCapabilityLedger");
    }
    this.baseUrl = baseUrl;
    const resolved = resolveRemoteOpts(optionsOrToken, principalId);
    this.token = resolved.token;
    this.principalId = resolved.principalId;
  }

  async load(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/caps`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });
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
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ envelopeId, actionDigest, principalId: this.principalId }),
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
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ filter, principalId: this.principalId }),
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
  readonly isIsolated = true;
  readonly __persistenceBackend = true as const;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly principalId?: string;

  constructor(
    baseUrl: string,
    optionsOrToken?: RemoteStoreOptions | string,
    principalId?: string,
  ) {
    if (!baseUrl) {
      throw new Error("[worker-persistence] controlPlaneUrl is required for RemotePersistenceBackend");
    }
    this.baseUrl = baseUrl;
    const resolved = resolveRemoteOpts(optionsOrToken, principalId);
    this.token = resolved.token;
    this.principalId = resolved.principalId;
  }

  async save(id: string, data: SessionData): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ id, data, principalId: this.principalId }),
    });
    if (!res.ok) {
      throw new Error(`[worker-persistence] Session save failed: HTTP ${res.status}`);
    }
  }

  async load(id: string): Promise<SessionData | null> {
    const res = await fetch(`${this.baseUrl}/api/sessions?sessionId=${encodeURIComponent(id)}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });
    if (res.ok) {
      return (await res.json()) as SessionData | null;
    }
    return null;
  }

  async delete(id: string): Promise<void> {
    await fetch(`${this.baseUrl}/api/sessions?sessionId=${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });
  }

  async list(): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/api/sessions`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });
    if (res.ok) {
      return (await res.json()) as string[];
    }
    return [];
  }
}

/**
 * Create and configure a tenant-scoped worker agent instance.
 */
export async function createWorkerAgent(config: WorkerTaskConfig): Promise<Seepient> {
  if (!config.controlPlaneUrl && (!config.auditStore || !config.policyStore || !config.capabilityLedger)) {
    throw new Error("[worker] controlPlaneUrl is required when external stores are not explicitly provided");
  }
  const token = config.controlPlaneToken ?? config.token;
  if (!token || token.trim().length === 0) {
    throw new ControlPlaneTokenRequiredError();
  }
  const remoteOpts: RemoteStoreOptions = {
    controlPlaneToken: token,
    principalId: config.principalId,
  };

  const auditStore = config.auditStore ?? new RemoteAuditStore(config.controlPlaneUrl, remoteOpts);
  const policyStore = config.policyStore ?? new RemotePolicyStore(config.controlPlaneUrl, remoteOpts);
  const capabilityLedger = config.capabilityLedger ?? new RemoteCapabilityLedger(config.controlPlaneUrl, remoteOpts);
  const persistence = config.persistence ?? (config.controlPlaneUrl ? new RemotePersistenceBackend(config.controlPlaneUrl, remoteOpts) : undefined);

  const agent = await createSeepient({
    tenancy: config.tenancy,
    principalId: config.principalId,
    sessionId: config.sessionId,
    cwd: config.workspaceDir,
    runtime: config.runtime,
    auditStore,
    policyStore,
    capabilityLedger,
    persist: persistence,
    consentMode: config.consentMode ?? "ask-everything",
    commitHelper: config.commitHelper,
    sources: config.sources,
    approvalBroker: {
      mode: "callback",
      request: async (req: PermissionRequest) => {
        if (config.relayApproval) {
          return config.relayApproval(req);
        }
        if (config.controlPlaneUrl) {
          const res = await fetch(`${config.controlPlaneUrl}/api/approvals`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
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
