import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const secDir = mkdtempSync(join(tmpdir(), `seepient-sec-test-${process.pid}-`));
process.env.SEEPIENT_SECURITY_DIR = secDir;
process.env.SEEPIENT_OVERLAY_PATH = join(secDir, "providers-overlay.json");
