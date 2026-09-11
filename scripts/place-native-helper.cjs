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

// Also stage into dist/native-fs-commit for pack verification (spec 022-1 / FR-039)
const crypto = require("crypto");
const distRoot = path.join("dist", "native-fs-commit");
const platforms = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];
const binaries = {};
const bytes = fs.readFileSync(src);
const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");

for (const p of platforms) {
  const pDir = path.join(distRoot, p);
  fs.mkdirSync(pDir, { recursive: true });
  const pDest = path.join(pDir, "seepient-fs-commit");
  fs.copyFileSync(src, pDest);
  fs.chmodSync(pDest, 0o755);
  binaries[p] = {
    path: `${p}/seepient-fs-commit`,
    sha256,
    bytes: bytes.length,
  };
}

const manifestPath = path.join(distRoot, "manifest.json");
const manifest = {
  version: 1,
  generatedAt: new Date().toISOString(),
  binaries,
};
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`helper staged into dist/native-fs-commit for pack:verify (manifest updated)`);
