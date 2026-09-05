---
title: Exact commit protection
description: Verified atomic file mutations using pre-image hashing and the native Rust helper.
---

# Exact commit protection

Language models frequently fail when modifying existing code. Common failure modes include:
- Dropping unedited code blocks between edited sections, replacing hundreds of lines with `// ... rest of code`.
- Miscalculating 1-indexed line numbers after prior edits.
- Overwriting external modifications made to the file while the model was thinking.

Seepient eliminates these failure modes by enforcing **exact commit verification** through a compiled native Rust helper (`native/fs-commit`).

---

## How exact commits work

When an agent proposes editing a file:

<DiagramFlow
  :steps="[
    { title: 'Preparation', desc: 'The agent reads the file, computes the SHA-256 pre-image hash, and declares the exact TargetContent & ReplacementContent' },
    { title: 'Verification', desc: 'seepient-fs-commit re-reads the target file on disk', chips: ['Verifies the disk file SHA-256 matches the pre-image hash', 'Confirms TargetContent occurs exactly once within the specified line range'] },
    { title: 'Atomic mutation', desc: 'Writes updated content to a temporary file, syncs to disk, and atomically renames it over the target' }
  ]"
/>
---

## The three safety checks

Before altering a single byte on disk, the commit helper verifies three invariants:

### 1. Pre-image hash verification
The tool records the SHA-256 digest of the target file before the model reasons. When the commit executes, the helper re-hashes the file. If another process or developer modified the file in the interim, the commit aborts with a `FILE_HASH_MISMATCH` error.

### 2. Exact target match
The helper searches for the exact character sequence specified in `TargetContent`. If whitespace, indentation, or punctuation differs by even one byte, the replacement is refused.

### 3. Uniqueness guarantee
If the target string appears multiple times in the file and the model did not specify a unique line slice, the helper aborts to prevent unintended edits in the wrong function.

---

## No unguarded write fallback

Many agent tools fall back to raw Node.js `fs.writeFileSync` if a native helper is missing or fails.

Seepient explicitly rejects unguarded fallbacks. If the native commit helper is not available (for example, running on native Windows outside WSL), file writes are refused before the approval prompt is shown. This invariant protects codebases from corrupted or truncated source files.
