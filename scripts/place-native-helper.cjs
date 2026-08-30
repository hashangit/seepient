/**
 * Place the freshly built native commit helper where `resolveBinaryPath`
 * looks during tsx dev runs: src/native-fs-commit/<platform>-<arch>/
 * (spec 019, FR-015 / QS-1.5 from-source story).
 */
const fs = require("fs");
const path = require("path");
const { platform, arch } = process;
const src = path.join("native", "fs-commit", "target", "release", "seepient-fs-commit");
if (!fs.existsSync(src)) {
  console.error(`helper binary not found at ${src} — run the cargo build first`);
  process.exit(1);
}
const destDir = path.join("src", "native-fs-commit", `${platform}-${arch}`);
fs.mkdirSync(destDir, { recursive: true });
const dest = path.join(destDir, "seepient-fs-commit");
fs.copyFileSync(src, dest);
fs.chmodSync(dest, 0o755);
console.log(`helper placed at ${dest}`);
