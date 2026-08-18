import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SeepientError } from "../../foundations/errors.js";

export interface ProviderAuditEvent {
  timestamp: string;
  action: "update_overlay" | "create_credential" | "delete_credential" | "rotate_credential";
  revision?: number;
  details: Record<string, any>;
}

function redactObject(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(redactObject);

  const result: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k.toLowerCase().includes("key") || k.toLowerCase().includes("secret") || k.toLowerCase().includes("token") || k.toLowerCase().includes("pass")) {
      result[k] = "[REDACTED]";
    } else if (typeof v === "object") {
      result[k] = redactObject(v);
    } else {
      result[k] = v;
    }
  }
  return result;
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
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
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
  }

  const redactedEvent = {
    ...event,
    details: redactObject(event.details),
  };

  const line = JSON.stringify(redactedEvent) + "\n";
  let fd: number | null = null;
  try {
    fd = fs.openSync(auditPath, fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_APPEND, 0o600);
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } catch (err: any) {
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
