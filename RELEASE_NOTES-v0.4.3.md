## [0.4.3] - 2026-08-14

**Seepient v0.4.3** completes the permission system overhaul (specs 008/011): the TUI approval prompt now shows one screen of complete, Domain-issued choices — Allow once / until you close Seepient / a safely bounded session choice — with plain-language authority summaries, a configurable approval deadline, and a containment preflight that fails with a setup message when the platform sandbox is missing. Persistent project/global grants are written through a crash-safe WAL (durable outbox intent, store-owned append-only mutation history, mutation-ID-bound recovery), and the permission pipeline gained a strict autonomous mode (prompt-free execution that still enforces ceiling, baseline, and immutable denies). The macOS sandbox allow list now includes the exec-time shell shim (`/private/var/select`), silencing dyld noise on every sandboxed shell spawn, and the TUI logo finally shows the real version.

---

### 🔧 What's New

#### TUI Permission Scope & Lifetime UX (spec 011)
* **One-screen complete approval choices**: the TUI approval prompt now shows all choices — Allow this action once, Allow this exact action until you close Seepient, and a safely bounded session choice when one is enforceable (bounded/action is never offered). Each choice carries a plain-language authority summary covering the complete capability delta, including mixed-capability actions.
* **Configurable approval deadline**: local prompts default to a ten-minute deadline, configurable via the `permissions.approvalTimeoutMs` setting. Approvals settle immediately on parent abort, session close, request replacement, or digest change.
* **Containment preflight**: when the platform sandbox is missing, the prompt fails `approval-unavailable` with a setup message before any prompt is shown — visible in `/permissions status`.
* **Strict request binding**: forged, stale, expired, or revoked selections fail closed; inline approval performs no grants or protected-policy writes. `/permissions status` shows the containment backend, writable root, and the live active-session authority set.
* **Autonomous mode**: the pipeline can now run prompt-free (`setAutonomousMode`) while still enforcing the deployment ceiling, runtime baseline, and immutable denies.

#### Crash-Safe Grant Persistence
* **WAL-durable persistent grants**: project/global grants flow through a durable outbox intent before the policy mutation; per-process pending files are reloaded and reconciled on restart, and recovery finalizes every unresolved grant by its unique mutation ID — never by version-plus-capability inference.
* **Store-owned append-only history**: the policy snapshot carries a per-mutation history that survives administrative approve/revoke mutations and is digest-covered.

#### Sandbox & Containment Hardening
* **macOS shell-shim fix**: the sandbox allow list includes `/private/var/select`, eliminating the non-fatal "Error opening /private/var/select/sh: Operation not permitted" dyld noise on every sandboxed shell spawn (regression canary asserts clean stderr).
* **Authoritative `TMPDIR`** and strict request binding in sandboxed execution; canonical security paths and fail-closed init under review fixes.
* **Bounded process choices** use executable + subcommand matchers only — shells, interpreters, package managers, and build drivers never receive an executable-wide session choice; candidates are ordered by authority containment and incomparable ones are omitted.
* **macOS git PATH shim**: sandboxed `git` prefers the CommandLineTools bin dir when `/usr/bin/git` would be selected.
* **Sanitized failure diagnostics**: failed command errors are trimmed and control characters stripped to keep terminal output bounded and readable.

---

### 🚀 Upgrade

| How you installed | Action |
| :--- | :--- |
| npm | `npm install -g seepient@latest` |
| Homebrew | `brew upgrade seepient` |
| pnpm | `pnpm add -g seepient` |
