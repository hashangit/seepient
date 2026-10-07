import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SeepientError } from "../../foundations/errors.js";
import { redact, redactUrlCredentials } from "../../foundations/security/redact.js";
import { ambientStoreDefaultsRegistered } from "../../foundations/injection-seams.js";

export interface ProviderAuditEvent {
  timestamp: string;
  action: "update_overlay" | "create_credential" | "delete_credential" | "rotate_credential";
  revision?: number;
  details: Record<string, any>;
}

export function redactObject(obj: any): any {
  return redact(obj);
}

/**
 * Appends an audit event to ~/.seepient/audit.log with 0600 permissions, symlink rejection, and fsync durability.
 */
export function recordProviderAuditEvent(event: ProviderAuditEvent, customAuditPath?: string): void {
  const auditPath =
    customAuditPath ??
    process.env.SEEPIENT_AUDIT_LOG_PATH ??
    path.join(os.homedir(), ".seepient", "audit.log");

  const dir = path.dirname(auditPath);
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  } catch (err) {
    // Review P1-3: the operator audit trail is a Profile-A convenience — on a
    // read-only $HOME (Lambda-style containers) the provider mutation must
    // still succeed. Fail soft with a warning; the security plane's own
    // AuditStore is a separate, injected concern.
    console.warn(
      `[seepient] provider audit log unavailable at ${auditPath} (${err instanceof Error ? (err as NodeJS.ErrnoException).code ?? err.message : err}); continuing without it`,
    );
    return;
  }

  // Reject symlinks
  if (fs.existsSync(auditPath)) {
    const lstat = fs.lstatSync(auditPath);
    if (lstat.isSymbolicLink()) {
      throw new SeepientError(
        `Audit log at ${auditPath} is a symbolic link. Refusing to write.`,
        "SECURITY_ERROR",
        false,
      );
    }
    // Repair loose permissions if needed
    try {
      if (process.platform !== "win32") {
        const mode = lstat.mode & 0o777;
        if (mode !== 0o600) {
          fs.chmodSync(auditPath, 0o600);
        }
      }
    } catch {}
  }

  const redactedEvent = {
    ...event,
    details: redact(event.details),
  };

  const line = JSON.stringify(redactedEvent) + "\n";
  let fd: number | null = null;
  const noFollow = fs.constants.O_NOFOLLOW !== undefined ? fs.constants.O_NOFOLLOW : 0;
  try {
    fd = fs.openSync(
      auditPath,
      fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_APPEND | noFollow,
      0o600,
    );
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } catch (err: any) {
    if (err.code === "ELOOP" || err.code === "EMLINK" || err.code === "EEXIST") {
      throw new SeepientError(
        `Audit log at ${auditPath} is a symbolic link or loop. Refusing to write.`,
        "SECURITY_ERROR",
        false,
      );
    }
    // Review round-2 P2-1: a pre-existing but unwritable dir (container layer,
    // wrong owner) is the same fail-soft case as mkdir — warn and continue.
    // Symlink refusals above stay fatal.
    if (err.code === "EACCES" || err.code === "EROFS" || err.code === "EPERM") {
      console.warn(
        `[seepient] provider audit log unwritable at ${auditPath} (${err.code}); continuing without it`,
      );
      return;
    }
    throw new SeepientError(
      `Failed to write durable audit log: ${err.message}`,
      "AUDIT_WRITE_FAILED",
      false,
    );
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

/**
 * Scrubs existing audit log of sensitive patterns in-place.
 */
export function scrubAuditLog(customAuditPath?: string): void {
  const auditPath =
    customAuditPath ??
    process.env.SEEPIENT_AUDIT_LOG_PATH ??
    path.join(os.homedir(), ".seepient", "audit.log");

  if (!fs.existsSync(auditPath)) return;

  const lstat = fs.lstatSync(auditPath);
  if (lstat.isSymbolicLink()) return;

  const content = fs.readFileSync(auditPath, "utf-8");
  const lines = content.split("\n");
  const scrubbedLines: string[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      const cleaned = redact(parsed);
      scrubbedLines.push(JSON.stringify(cleaned));
    } catch {
      scrubbedLines.push(redact(line));
    }
  }

  const tmpPath = `${auditPath}.scrub.${Date.now()}.tmp`;
  const fd = fs.openSync(tmpPath, fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_TRUNC, 0o600);
  fs.writeSync(fd, scrubbedLines.join("\n") + (scrubbedLines.length ? "\n" : ""));
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmpPath, auditPath);
}

