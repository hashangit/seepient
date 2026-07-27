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

  constructor(opts?: { root?: string }) {
    this.dir =
      opts?.root ??
      path.join(os.homedir(), ".seepient", "security", "approvals");
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
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as ApprovalRecord;
        this.records.set(rec.request.requestId, rec);
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

  listPending(principalIdOrOpts?: string | { principalId?: string; tenantId?: string; sessionId?: string }): PendingApprovalRecord[] {
    const pId = typeof principalIdOrOpts === "string" ? principalIdOrOpts : principalIdOrOpts?.principalId;
    const now = Date.now();
    const pending: PendingApprovalRecord[] = [];
    for (const rec of this.records.values()) {
      const r = rec as any as PendingApprovalRecord;
      if (r.status === "pending" && r.request && r.request.expiresAt > now) {
        if (!pId || r.request.principalId === pId) {
          pending.push(r);
        }
      }
    }
    return pending;
  }
  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    try {
      await fs.chmod(this.dir, 0o700);
    } catch { /* non-fatal */ }
  }

  private async persist(): Promise<void> {
    const lines = [...this.records.values()]
      .map((r) => JSON.stringify(r))
      .join("\n") + "\n";
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
    const existing = [...this.records.values()].find((r: any) => r.request?.requestId === input.request.requestId || r.continuationId === input.continuationId);
    if (existing) return existing as any;

    const rec: PendingApprovalRecord = {
      continuationId: input.continuationId,
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      request: input.request,
      version: 1,
      status: "pending",
    };
    this.records.set(input.continuationId, rec as any);
    void this.saveRequest(input.request);
    return rec;
  }

  get(continuationId: string): (PendingApprovalRecord & { state: string }) | undefined {
    const rec = this.records.get(continuationId) as any as PendingApprovalRecord;
    if (!rec) return undefined;
    return {
      ...rec,
      state: rec.status,
    };
  }

  cas(
    continuationId: string,
    expectedVersion: number,
    decision: PermissionDecision,
  ): { status: "transitioned" | "duplicate" | "stale" | "expired"; record?: PendingApprovalRecord } {
    const rec = this.records.get(continuationId) as any as PendingApprovalRecord;
    if (!rec) return { status: "stale" };
    if (rec.version !== expectedVersion) return { status: "stale" };
    if (rec.status !== "pending") return { status: "duplicate" };
    if (rec.request.expiresAt <= Date.now()) {
      rec.status = "expired";
      return { status: "expired", record: rec };
    }
    rec.status = decision.approved ? "approved" : "denied";
    rec.decision = decision;
    rec.version += 1;
    void this.resolveRequest(decision);
    return { status: "transitioned", record: rec };
  }

  listPendingSync(principalId?: string): PendingApprovalRecord[] {
    const now = Date.now();
    const pending: PendingApprovalRecord[] = [];
    for (const rec of this.records.values()) {
      const r = rec as any as PendingApprovalRecord;
      if (r.status === "pending" && r.request && r.request.expiresAt > now) {
        if (!principalId || r.request.principalId === principalId) {
          pending.push(r);
        }
      }
    }
    return pending;
  }

  cancel(continuationId: string): void {
    const rec = this.records.get(continuationId) as any as PendingApprovalRecord;
    if (rec && rec.status === "pending") {
      rec.status = "cancelled";
    }
  }

  reevaluate(continuationId: string, allowedInput: boolean | ((req: PermissionRequest) => boolean)): void {
    const rec = this.records.get(continuationId) as any as PendingApprovalRecord;
    if (!rec) return;
    const isAllowed = typeof allowedInput === "function" ? allowedInput(rec.request) : allowedInput;
    if (rec.status === "approved" && !isAllowed) {
      rec.status = "denied";
    }
  }
}

export { DurableApprovalStore as PendingApprovalStore };
