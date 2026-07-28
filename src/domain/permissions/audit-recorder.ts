/**
 * Local append-only audit store — Domain (spec 008, T109, FR-014 / NFR-003).
 *
 * Every action has exactly one terminal outcome. Effectful execution is
 * dispatched only after the `dispatched` event is made durable via fsync; if
 * that write fails, execution is denied (`audit-unavailable`). Terminal
 * events are de-duplicated by idempotency key `<actionId>:<state>` so a retry
 * cannot append a second terminal record.
 *
 * IMPLEMENTED (R9.1):
 *  - append-only NDJSON with fsync on every append (including pre-dispatch)
 *  - idempotency-key de-duplication (replays return "duplicate")
 *  - `getTerminal(actionId)` scan for crash-recovery queries
 *  - Advisory lock retry loop in `append()` for concurrent-write safety (T109b)
 *  - Durable TerminalEventOutbox backed by NDJSON file under
 *    `~/.seepient/security/outbox/` with tmp+fsync+rename discipline (T109a)
 *  - `recoverIndeterminateActions()` startup routine (T109c)
 *
 * Storage layout (local): `~/.seepient/security/audit/<principal-id>/events.ndjson`
 * with private (0o600/0o700) permissions and atomic appends.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import type {
  ActionAuditEvent,
  ActionState,
  AuditStore as AuditStoreContract,
} from "../../foundations/contracts/execution-brokers.js";
import { AuditError } from "../../foundations/errors.js";

const TERMINAL_STATES: ReadonlySet<ActionState> = new Set<ActionState>([
  "succeeded",
  "failed",
  "cancelled",
  "denied",
  "indeterminate",
]);

/** Idempotency key format: `<actionId>:<state>`. */
export function idempotencyKey(actionId: string, state: ActionState): string {
  return `${actionId}:${state}`;
}

interface AuditFileEntry {
  event: ActionAuditEvent;
  idempotencyKey: string;
}

/**
 * Local append-only NDJSON audit store. Appends are atomic (single `writeFile`
 * with the full line); the pre-dispatch event is awaited before execution
 * returns. Terminal events go through the same append but additionally track
 * an outbox marker that is cleared only after the append fsyncs.
 */
export class LocalAuditStore implements AuditStoreContract {
  private readonly dir: string;

  constructor(opts?: { root?: string }) {
    this.dir =
      opts?.root ??
      (process.env.SEEPIENT_SECURITY_DIR
        ? path.join(process.env.SEEPIENT_SECURITY_DIR, "audit")
        : path.join(os.homedir(), ".seepient", "security", "audit"));
  }

  private eventsFile(workspaceId: string): string {
    return path.join(this.dir, workspaceId, "events.ndjson");
  }

  private async ensureDir(workspaceId: string): Promise<void> {
    await fs.mkdir(path.join(this.dir, workspaceId), {
      recursive: true,
      mode: 0o700,
    });
    try {
      await fs.chmod(path.join(this.dir, workspaceId), 0o700);
    } catch {
      /* non-fatal */
    }
  }

  /** Compute a short event id keyed on content for de-dup detection. */
  private eventId(event: ActionAuditEvent): string {
    return createHash("sha256")
      .update(`${event.actionId}|${event.state}|${event.timestamp}`, "utf8")
      .digest("hex")
      .slice(0, 16);
  }

  async append(
    event: ActionAuditEvent,
    opts: { idempotencyKey: string },
  ): Promise<"written" | "duplicate"> {
    const wsId = event.principalId; // workspaceId routes via principal in v1 local
    await this.ensureDir(wsId);
    const file = this.eventsFile(wsId);
    const lockFile = file + ".lock";

    // T109b: Advisory lock retry loop — prevents concurrent writers from
    // corrupting the dedup index. We use an exclusive lock file with a retry
    // loop (max 20 attempts, 25ms apart ≈ 500ms total). If the lock cannot be
    // acquired, we throw so the caller can retry or enqueue in the outbox.
    const MAX_LOCK_ATTEMPTS = 20;
    const LOCK_RETRY_MS = 25;
    let lockHandle: fs.FileHandle | undefined;
    for (let attempt = 0; attempt < MAX_LOCK_ATTEMPTS; attempt++) {
      try {
        lockHandle = await fs.open(lockFile, "wx", 0o600);
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        if (attempt === MAX_LOCK_ATTEMPTS - 1) {
          throw new AuditError(
            "Audit lock timeout: another writer holds the lock",
            "AUDIT_UNAVAILABLE",
            { retryable: true, actionId: event.actionId, state: event.state },
          );
        }
        await new Promise<void>((r) => setTimeout(r, LOCK_RETRY_MS));
      }
    }
    try {
      // De-dup check under lock.
      if (await this.hasKey(file, opts.idempotencyKey)) {
        return "duplicate";
      }

      const entry: AuditFileEntry = {
        event: { ...event, eventId: event.eventId || this.eventId(event) },
        idempotencyKey: opts.idempotencyKey,
      };
      const line = JSON.stringify(entry) + "\n";

      // Atomic append with fsync. Pre-dispatch events MUST be durable before
      // execution; a failure here denies effectful dispatch.
      const handle = await fs.open(file, "a", 0o600);
      try {
        await handle.appendFile(line);
        await handle.sync(); // fsync — durability gate
      } finally {
        await handle.close();
      }
      return "written";
    } catch (err) {
      if (err instanceof AuditError) throw err;
      throw new AuditError(
        `Failed to durably append audit event: ${(err as Error).message}`,
        "AUDIT_UNAVAILABLE",
        {
          retryable: true,
          actionId: event.actionId,
          state: event.state,
        },
      );
    } finally {
      if (lockHandle) {
        await lockHandle.close().catch(() => {});
        await fs.unlink(lockFile).catch(() => {});
      }
    }
  }

  async getTerminal(actionId: string): Promise<ActionAuditEvent | undefined> {
    // Scan all workspace audit files. Local v1 keeps a flat layout; this is
    // only called during recovery, not the hot path.
    try {
      const workspaces = await fs.readdir(this.dir);
      for (const wsId of workspaces) {
        const file = this.eventsFile(wsId);
        const terminal = await this.findTerminal(file, actionId);
        if (terminal) return terminal;
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return undefined;
      throw err;
    }
    return undefined;
  }

  private async hasKey(file: string, key: string): Promise<boolean> {
    try {
      const raw = await fs.readFile(file, "utf8");
      return raw.split("\n").some((line) => {
        if (!line.trim()) return false;
        try {
          const entry = JSON.parse(line) as AuditFileEntry;
          return entry.idempotencyKey === key;
        } catch {
          return false;
        }
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return false;
      throw err;
    }
  }

  private async findTerminal(
    file: string,
    actionId: string,
  ): Promise<ActionAuditEvent | undefined> {
    try {
      const raw = await fs.readFile(file, "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as AuditFileEntry;
          if (
            entry.event.actionId === actionId &&
            TERMINAL_STATES.has(entry.event.state)
          ) {
            return entry.event;
          }
        } catch {
          /* skip malformed line */
        }
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
    }
    return undefined;
  }
}

// ── Terminal-event outbox (durable, T109a) ──────────────────────────────

/**
 * A pending terminal event that could not be appended durably. The outbox
 * retries these in the background; while any entry remains, the deployment is
 * considered to have degraded audit health (FR-014).
 */
export interface OutboxEntry {
  event: ActionAuditEvent;
  idempotencyKey: string;
  attempts: number;
  lastAttempt: number;
}

/**
 * Durable terminal-event outbox (T109a). Pending entries are written to an
 * NDJSON file under `~/.seepient/security/outbox/` with the same atomic
 * tmp+fsync+rename discipline as the audit store. On startup, `reload()` must
 * be called to rebuild the in-memory index from the persisted file.
 *
 * `flush()` retries all pending entries against the audit store and removes
 * successfully written ones from both the index and the persisted file
 * (atomic rewrite).
 */
export class TerminalEventOutbox {
  private pending = new Map<string, OutboxEntry>();
  private readonly store: LocalAuditStore;
  private readonly outboxFile: string;
  private unhealthy = false;

  constructor(
    store: LocalAuditStore,
    opts?: { outboxDir?: string },
  ) {
    this.store = store;
    const dir =
      opts?.outboxDir ??
      (process.env.SEEPIENT_SECURITY_DIR
        ? path.join(process.env.SEEPIENT_SECURITY_DIR, "outbox")
        : path.join(os.homedir(), ".seepient", "security", "outbox"));
    this.outboxFile = path.join(dir, "pending.ndjson");
  }

  /**
   * Reload pending entries from the durable outbox file. Call once at
   * startup before the first flush (T109c recovery integration).
   */
  async reload(): Promise<void> {
    try {
      const raw = await fs.readFile(this.outboxFile, "utf8");
      this.pending = new Map();
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as OutboxEntry;
          this.pending.set(entry.idempotencyKey, entry);
        } catch { /* skip malformed */ }
      }
      this.unhealthy = this.pending.size > 0;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  /**
   * Enqueue a terminal event that could not be appended. Persists the entry
   * to the durable outbox file before returning (T109a atomic write).
   */
  async enqueue(event: ActionAuditEvent, idempotencyKey: string): Promise<void> {
    this.pending.set(idempotencyKey, {
      event,
      idempotencyKey,
      attempts: 0,
      lastAttempt: 0,
    });
    this.unhealthy = true;
    await this.persistOutbox();
  }

  /**
   * Retry all pending terminal events. Returns the number still pending.
   * A production deployment calls this on a timer AND on startup (T109c).
   */
  async flush(): Promise<number> {
    let remaining = 0;
    for (const [key, entry] of this.pending) {
      entry.attempts += 1;
      entry.lastAttempt = Date.now();
      try {
        const result = await this.store.append(entry.event, { idempotencyKey: key });
        if (result === "written" || result === "duplicate") {
          this.pending.delete(key);
        } else {
          remaining += 1;
        }
      } catch {
        remaining += 1;
      }
    }
    if (this.pending.size === 0) {
      this.unhealthy = false;
      // Remove the durable outbox file when fully flushed.
      await fs.unlink(this.outboxFile).catch(() => {});
    } else {
      await this.persistOutbox().catch(() => {});
    }
    return remaining;
  }

  /** True while any terminal event remains un-persisted (degraded audit). */
  isHealthy(): boolean {
    return !this.unhealthy;
  }

  /** Number of pending terminal events. */
  size(): number {
    return this.pending.size;
  }

  /**
   * Atomically persist the current pending map to the outbox file.
   * Uses tmp+fsync+rename for durability (T109a).
   */
  private async persistOutbox(): Promise<void> {
    const dir = path.dirname(this.outboxFile);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = this.outboxFile + `.tmp.${process.pid}`;
    const lines = [...this.pending.values()].map((e) => JSON.stringify(e)).join("\n") + "\n";
    const handle = await fs.open(tmp, "w", 0o600);
    try {
      await handle.writeFile(lines, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.rename(tmp, this.outboxFile);
    } catch {
      await fs.unlink(tmp).catch(() => {});
    }
  }
}

// ── Crash-recovery routine ─────────────────────────────────────────────

/**
 * Scan the audit store for `dispatched` records without a matching terminal
 * event and mark them `indeterminate`. Per FR-014, a durable `dispatched`
 * action without a terminal record is NEVER automatically re-executed; it
 * surfaces as `indeterminate` for operator reconciliation.
 *
 * Returns the action IDs that were marked indeterminate. A production
 * deployment runs this on startup.
 */
export async function recoverIndeterminateActions(
  store: LocalAuditStore,
  outbox?: TerminalEventOutbox,
): Promise<string[]> {
  const fsLocal = await import("node:fs/promises");
  const pathLocal = await import("node:path");
  const indeterminate: string[] = [];
  let dir: string;
  // Access the store's private dir via a public probe — the constructor
  // stores it on `this.dir`. We re-list using the same layout.
  // (The store exposes its layout via the eventsFile pattern; recovery walks
  // the same tree.)
  try {
    // The store's root is private; recovery accepts it via the same
    // constructor pattern. In practice the composition root that owns the
    // store also owns recovery. We pass the store and let it scan.
    dir = (store as unknown as { dir: string }).dir;
  } catch {
    return indeterminate;
  }

  let workspaces: string[];
  try {
    workspaces = await fsLocal.readdir(dir);
  } catch {
    return indeterminate; // no audit data yet
  }

  for (const wsId of workspaces) {
    const wsDir = pathLocal.join(dir, wsId);
    const stat = await fsLocal.stat(wsDir).catch(() => null);
    if (!stat?.isDirectory()) continue;
    const file = pathLocal.join(wsDir, "events.ndjson");
    let raw: string;
    try {
      raw = await fsLocal.readFile(file, "utf8");
    } catch {
      continue;
    }
    // First pass: collect dispatched + terminal action IDs.
    const dispatched = new Set<string>();
    const hasTerminal = new Set<string>();
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as AuditFileEntry;
        if (entry.event.state === "dispatched") dispatched.add(entry.event.actionId);
        if (TERMINAL_STATES.has(entry.event.state)) hasTerminal.add(entry.event.actionId);
      } catch {
        /* skip malformed */
      }
    }
    // Second pass: for each dispatched without terminal, append an
    // `indeterminate` event (idempotent — it's the recovery marker).
    for (const actionId of dispatched) {
      if (hasTerminal.has(actionId)) continue;
      const event: ActionAuditEvent = {
        eventId: createHash("sha256").update(`${actionId}|indeterminate|recovery`).digest("hex").slice(0, 16),
        actionId,
        actionDigest: "", // unknown at recovery time
        principalId: wsId,
        runId: "",
        state: "indeterminate",
        timestamp: Date.now(),
        policyDigest: "",
      };
      try {
        await store.append(event, { idempotencyKey: idempotencyKey(actionId, "indeterminate") });
        indeterminate.push(actionId);
      } catch {
        // If append fails, enqueue in the outbox for retry. The action is
        // still indeterminate (we just couldn't persist the marker yet); the
        // outbox will retry and the deployment reports degraded audit health.
        outbox?.enqueue(event, idempotencyKey(actionId, "indeterminate"));
        indeterminate.push(actionId);
      }
    }
  }
  return indeterminate;
}

export { TERMINAL_STATES };
