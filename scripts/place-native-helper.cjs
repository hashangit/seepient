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
const hostPlatform = `${platform}-${arch}`;
const binaries = {};
const bytes = fs.readFileSync(src);
const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");

let hasPlaceholders = false;

for (const p of platforms) {
  const pDir = path.join(distRoot, p);
  fs.mkdirSync(pDir, { recursive: true });
  const pDest = path.join(pDir, "seepient-fs-commit");
  if (p === hostPlatform) {
    fs.copyFileSync(src, pDest);
    fs.chmodSync(pDest, 0o755);
    binaries[p] = {
      path: `${p}/seepient-fs-commit`,
      sha256,
      bytes: bytes.length,
    };
  } else {
    let isReal = false;
    if (fs.existsSync(pDest) && fs.statSync(pDest).size > 0) {
      const pBytes = fs.readFileSync(pDest);
      const isPlaceholder = pBytes.toString("utf8").includes("seepient-fs-commit-placeholder");
      const pSha = crypto.createHash("sha256").update(pBytes).digest("hex");
      if (!isPlaceholder && pSha !== sha256) {
        isReal = true;
        binaries[p] = {
          path: `${p}/seepient-fs-commit`,
          sha256: pSha,
          bytes: pBytes.length,
        };
      }
    }
    if (!isReal) {
      hasPlaceholders = true;
      fs.writeFileSync(pDest, "#!/bin/sh\necho seepient-fs-commit-placeholder\n", { mode: 0o755 });
      const pBytes = fs.readFileSync(pDest);
      binaries[p] = {
        path: `${p}/seepient-fs-commit`,
        sha256: crypto.createHash("sha256").update(pBytes).digest("hex"),
        bytes: pBytes.length,
      };
    }
  }
}

const manifestPath = path.join(distRoot, "manifest.json");
const manifest = {
  version: 1,
  generatedAt: new Date().toISOString(),
  ...(hasPlaceholders ? { placeholder: true } : {}),
  binaries,
};
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`helper staged into dist/native-fs-commit for pack:verify (manifest updated)`);
