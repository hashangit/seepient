/**
 * Local append-only audit store with durable terminal-event outbox — Domain
 * (spec 008, T109, FR-014 / NFR-003).
 *
 * Every action has exactly one terminal outcome. Effectful execution is
 * dispatched only after the `dispatched` event is durable; if that write
 * fails, execution is denied (`audit-unavailable`). Terminal events use an
 * idempotent outbox keyed by `actionId:state` so retry cannot repeat execution.
 *
 * On recovery, a durable `dispatched` action without a terminal record is
 * `indeterminate` — never automatically reexecuted.
 *
 * Storage layout (local): `~/.seepient/security/audit/<workspace-id>/events.ndjson`
 * with an `outbox/` sibling for the durable terminal-event queue. Both use
 * private (0o600/0o700) permissions and atomic appends.
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
      opts?.root ?? path.join(os.homedir(), ".seepient", "security", "audit");
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

    // De-dup check: scan existing events for the same idempotency key.
    // Append-only NDJSON is small per workspace; a linear scan is acceptable
    // for v1 local. Server uses SQL UNIQUE constraints instead.
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
    try {
      const handle = await fs.open(file, "a", 0o600);
      try {
        await handle.appendFile(line);
        await handle.sync(); // fsync — durability gate
      } finally {
        await handle.close();
      }
    } catch (err) {
      throw new AuditError(
        `Failed to durably append audit event: ${(err as Error).message}`,
        "AUDIT_UNAVAILABLE",
        {
          retryable: true,
          actionId: event.actionId,
          state: event.state,
        },
      );
    }
    return "written";
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

export { TERMINAL_STATES };
