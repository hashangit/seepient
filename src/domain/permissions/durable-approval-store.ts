/**
 * Durable Approval Store — Domain (spec 008, FR-016, D31 / server-policy contract).
 *
 * Remote approvals (WebSocket, HTTP REST `/permissions/requests`) must survive
 * socket disconnects, process restarts, and multi-instance restarts.
 * Pending requests and decided outcomes are persisted under
 * `~/.seepient/security/approvals/` with atomic writes (tmp + fsync + rename).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type {
  PermissionRequest,
  PermissionDecision,
} from "../../foundations/contracts/permission-policy.js";

export interface ApprovalRecord {
  request: PermissionRequest;
  decision?: PermissionDecision;
  createdAt: number;
  updatedAt: number;
}

export interface PendingApprovalRecord {
  continuationId: string;
  tenantId: string;
  sessionId: string;
  request: PermissionRequest;
  version: number;
  status: "pending" | "approved" | "denied" | "cancelled" | "expired";
  decision?: PermissionDecision;
}
export class DurableApprovalStore {
  private readonly dir: string;
  private records = new Map<string, ApprovalRecord>();
  private pendingRecords = new Map<string, PendingApprovalRecord>();
  constructor(opts?: { root?: string }) {
    this.dir =
      opts?.root ??
      (process.env.SEEPIENT_SECURITY_DIR
        ? path.join(process.env.SEEPIENT_SECURITY_DIR, "approvals")
        : path.join(os.homedir(), ".seepient", "security", "approvals"));
  }

  private get file(): string {
    return path.join(this.dir, "store.ndjson");
  }

  async load(): Promise<void> {
    await this.ensureDir();
    let raw: string;
    try {
      raw = await fs.readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    this.records = new Map();
    this.pendingRecords = new Map();
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.kind === "pending" || obj.continuationId) {
          const rec = obj as PendingApprovalRecord;
          this.pendingRecords.set(rec.continuationId, rec);
        } else if (obj.request?.requestId) {
          const rec = obj as ApprovalRecord;
          this.records.set(rec.request.requestId, rec);
        }
      } catch {
        /* skip malformed lines */
      }
    }
  }

  async saveRequest(req: PermissionRequest): Promise<void> {
    await this.ensureDir();
    const existing = this.records.get(req.requestId);
    const rec: ApprovalRecord = {
      request: req,
      decision: existing?.decision,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    this.records.set(req.requestId, rec);
    await this.persist();
  }

  async resolveRequest(decision: PermissionDecision): Promise<void> {
    await this.ensureDir();
    const existing = this.records.get(decision.requestId);
    if (!existing) return;
    existing.decision = decision;
    existing.updatedAt = Date.now();
    this.records.set(decision.requestId, existing);
    await this.persist();
  }

  async getRequest(requestId: string): Promise<PermissionRequest | undefined> {
    await this.load();
    const rec = this.records.get(requestId);
    if (!rec) return undefined;
    if (rec.request.expiresAt < Date.now()) return undefined; // expired
    return rec.request;
  }

  async getDecision(requestId: string): Promise<PermissionDecision | undefined> {
    await this.load();
    return this.records.get(requestId)?.decision;
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    try {
      await fs.chmod(this.dir, 0o700);
    } catch { /* non-fatal */ }
  }

  private async persist(): Promise<void> {
    await this.ensureDir();
    const reqLines = [...this.records.values()].map((r) => JSON.stringify({ kind: "request", ...r }));
    const pendingLines = [...this.pendingRecords.values()].map((r) => JSON.stringify({ kind: "pending", ...r }));
    const lines = [...reqLines, ...pendingLines].join("\n") + "\n";
    const tmp = path.join(this.dir, `store.tmp.${process.pid}.${Date.now()}`);
    const handle = await fs.open(tmp, "w", 0o600);
    try {
      await handle.writeFile(lines, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.rename(tmp, this.file);
    } catch {
      await fs.unlink(tmp).catch(() => {});
    }
  }
  create(input: {
    request: PermissionRequest;
    tenantId: string;
    sessionId: string;
    continuationId: string;
  }): PendingApprovalRecord {
    const existing = [...this.pendingRecords.values()].find(
      (r) => r.request?.requestId === input.request.requestId || r.continuationId === input.continuationId,
    );
    if (existing) return existing;

    const rec: PendingApprovalRecord = {
      continuationId: input.continuationId,
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      request: input.request,
      version: 1,
      status: "pending",
    };
    this.pendingRecords.set(input.continuationId, rec);
    void this.saveRequest(input.request);
    void this.persist();
    return rec;
  }

  get(continuationId: string): (PendingApprovalRecord & { state: string }) | undefined {
    const rec = this.pendingRecords.get(continuationId);
    if (!rec) return undefined;
    return {
      ...rec,
      state: rec.status,
    };
  }
  casSync(
    continuationId: string,
    expectedVersion: number,
    decision: PermissionDecision,
    now = Date.now(),
  ): { status: "transitioned" | "duplicate" | "stale" | "expired"; record?: PendingApprovalRecord } {
    const rec = this.pendingRecords.get(continuationId);
    if (!rec) return { status: "stale" };
    if (rec.status !== "pending") return { status: "duplicate", record: rec };
    if (rec.version !== expectedVersion) return { status: "stale" };
    if (rec.request.expiresAt <= now) {
      rec.status = "expired";
      void this.persist();
      return { status: "expired", record: rec };
    }
    rec.status = decision.approved ? "approved" : "denied";
    rec.decision = decision;
    rec.version += 1;
    this.records.set(continuationId, rec as any);
    void this.resolveRequest(decision);
    void this.persist();
    return { status: "transitioned", record: rec };
  }
  cas(
    continuationId: string,
    expectedVersion: number,
    decision: PermissionDecision,
    now = Date.now(),
  ): Promise<{ status: "transitioned" | "duplicate" | "stale" | "expired"; record?: PendingApprovalRecord }> & { status: "transitioned" | "duplicate" | "stale" | "expired"; record?: PendingApprovalRecord } {
    const res = this.casSync(continuationId, expectedVersion, decision, now);
    const promise = this.persist().then(() => res);
    return Object.assign(promise, res);
  }
  listPendingSync(principalId?: string): PendingApprovalRecord[] {
    const now = Date.now();
    const pending: PendingApprovalRecord[] = [];
    for (const r of this.pendingRecords.values()) {
      if (r.status === "pending" && r.request && r.request.expiresAt > now) {
        if (!principalId || r.request.principalId === principalId) {
          pending.push(r);
        }
      }
    }
    return pending;
  }

  listPending(principalIdOrOpts?: string | { principalId?: string; tenantId?: string; sessionId?: string }): PendingApprovalRecord[] {
    const pId = typeof principalIdOrOpts === "string" ? principalIdOrOpts : principalIdOrOpts?.principalId;
    return this.listPendingSync(pId);
  }

  cancel(continuationId: string): void {
    const rec = this.pendingRecords.get(continuationId);
    if (rec && rec.status === "pending") {
      rec.status = "cancelled";
      void this.persist();
    }
  }

  reevaluate(continuationId: string, allowedInput: boolean | ((req: PermissionRequest) => boolean)): void {
    const rec = this.pendingRecords.get(continuationId);
    if (!rec) return;
    const isAllowed = typeof allowedInput === "function" ? allowedInput(rec.request) : allowedInput;
    if (!isAllowed) {
      rec.status = "denied";
      void this.persist();
    }
  }
}

export { DurableApprovalStore as PendingApprovalStore };
