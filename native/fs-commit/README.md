# seepient-fs-commit

Native exact-commit helper for Seepient (spec 008/019). It owns the complete
validate → write → revalidate → rename sequence for one file commit so that
symlink and TOCTOU swaps cannot redirect an approved write.

Protocol contract: `docs` live in the Seepient vault at
`Implementation-Specs/019-exact-commit-enforcement/contracts/native-helper-protocol.md`;
the TypeScript wrapper (`src/vendors/native-fs-commit/index.ts`) is the other
half of this interface and must be updated in the same change as this binary.

## Invocation

```
seepient-fs-commit --commit <destination> [--expected-sha256 <64-hex>]
```

- Content arrives as **raw bytes on stdin** (binary-safe).
- Result is a **single-line JSON object on stdout**:
  `{"ok":true,"writtenSha256":"<64-hex>","errorCode":null,"message":null}`
  or `{"ok":false,"writtenSha256":"","errorCode":"<code>","message":"..."}`
- Diagnostics go to stderr (never parsed by the wrapper).
- Exit code 0 for both success and structured refusals (the wrapper reads the
  JSON); non-zero only for internal panics.
- The wrapper spawns with `shell:false`; the binary never invokes a shell.

Error codes (closed set): `target-symlink`, `parent-symlink`,
`parent-replaced`, `snapshot-changed`, `cross-device-rename`, `io-error`,
`timeout`, `primitive-unsupported`.

## Security invariants

- Never follows a symlink in any path component, including the final one.
- Never reads environment variables for behavior; never touches the network.
- Never writes anywhere except the destination's own directory (private
  0600 `O_EXCL` temp sibling) and the destination itself.
- Deterministic, side-effect-free refusals: no temp left behind, destination
  untouched.
- No logging of content; messages carry paths and codes only.
- Self-limits to 10 s total; expiry reports `timeout`.

## Why `libc`

std has no equivalent of the primitives the guarantees require: Linux
`openat2` with `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_XDEV`,
directory-relative `openat` with `O_NOFOLLOW` on macOS, and raw directory
`fsync`. `libc` is the only dependency; SHA-256 is a self-contained
std-only implementation in `src/sha256.rs`.
