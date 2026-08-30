# Seepient v0.5.7 Release Notes

Seepient v0.5.7 delivers native exact-commit filesystem enforcement, migrates media capabilities to vendor-neutral ProviderRuntime routing, adds analyzer-time shell syntax validation, hardens terminal multi-line paste handling, and enforces registry-only trusted host tool execution.

---

### Key changes

#### 1. Exact-commit enforcement and native helper (Spec 019)
* **Native write verification:** File modifications (`write_file`, `edit_file`, and image outputs) route through a compiled native Rust helper (`seepient-fs-commit`) that validates SHA-256 pre-snapshots and path traversal before writing.
* **Fail-closed pre-prompt gate:** Missing or checksum-mismatched helpers trigger `exact-commit-unavailable` before user prompting, eliminating approve-then-fail round trips.
* **Demolition of JS filesystem fallback:** The interim JavaScript fallback and `SEEPIENT_ALLOW_JS_FS_FALLBACK` override have been removed.
* **In-memory patch validation for `edit_file`:** Patches are validated and applied against the session snapshot store in memory before exact target bytes are committed to disk.
* **Workspace `.env` protection:** Refuses overrides to `SEEPIENT_UNCONTAINED` or `SEEPIENT_FS_COMMIT_BIN` from project-local `.env` files.

#### 2. Media capability ProviderRuntime routing & vendor-neutral migration
* **ProviderRuntime routing:** Image generation and prompt optimization route exclusively through `ProviderRuntime` using the `image-generation` model slot.
* **Legacy settings removal:** Decommissioned legacy `image.*` settings (`image.apiKey`, `image.baseUrl`, `image.model`, `image.size`, `image.quality`, `image.style`, `image.n`). Configuration is managed through `/models` or CLI `seepient models image`.
* **Broker-managed file outputs:** `generate_image` file destinations commit directly through the `FileCommitBroker` pipeline.

#### 3. Shell error reduction & analyzer validation
* **Syntax preflight:** `analyzeExecuteShellCommand` performs analyzer-time syntax validation (`/bin/sh -n -c`) before permission prompting on POSIX systems, returning `SHELL_SYNTAX_INVALID` with diagnostics and quoting remediation hints.
* **Sandbox quoting:** Double-quoting with backslash escapes in `AsrtSandbox` ensures command tokens survive internal shell wrapper execution intact.
* **Model prompt guidance:** Updated system prompts with shell quoting best practices, modern CLI flags (e.g. ImageMagick 7 `magick`), and direction toward dedicated tools.

#### 4. Terminal input & paste reliability
* **Bracketed paste & coalescing:** The TUI `TextInput` handles terminal bracketed paste sequences (`\x1b[200~` / `\x1b[201~`) and coalesces rapid chunks, preventing multi-line pastes from dropping characters or triggering accidental submissions.
* **Safe draft clear:** `Ctrl+C` with text in the prompt clears the draft input instead of quitting the application. Pressing `Ctrl+C` on an empty prompt exits cleanly.
* **Commit helper status line:** The TUI footer displays exact commit status (`exact commits: on`, `off (helper missing)`, or `off (digest mismatch)`).

#### 5. SDK custom tools & trusted host security
* **Registry-only custom tools:** Ambient tool-registry execution is removed; custom tools must be registered via `trustedHostTool` exported directly from `seepient`.
* **Operator allowlist:** `permissions.trustedHostAllowlist` (default `["use_skill"]`) controls which host tools execute without prompts.
* **Upstream sync:** Bumped `@earendil-works/pi-ai` to `0.84.4`.
