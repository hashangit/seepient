import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const secDir = mkdtempSync(join(tmpdir(), `seepient-sec-test-${process.pid}-`));
process.env.SEEPIENT_SECURITY_DIR = secDir;
process.env.SEEPIENT_OVERLAY_PATH = join(secDir, "providers-overlay.json");
// Round-3 P2-2: recordProviderAuditEvent consults only this var — without the
// redirect, full-package test paths appended to the operator's real
// ~/.seepient/audit.log on every run.
process.env.SEEPIENT_AUDIT_LOG_PATH = join(secDir, "provider-audit.log");
process.env.SEEPIENT_RATE_LIMIT_RPM = "0";
