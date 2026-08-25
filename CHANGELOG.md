# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [v0.5.0] - 2026-08-25

**Seepient v0.5.0** is a major product and architectural milestone delivering the complete **Provider Management TUI & In-App Lifecycle Experience (Spec 013)**, unifying the runtime modernization from Spec 010 into an intuitive, keyboard-first terminal interface. 

This release introduces the **shared ModelPicker** with search-as-you-type and reachability gating, the **rebuilt ModelManager dock (`/models`)** with a live Purpose × Tier jobs board and full in-app provider account management, a **modernized Setup Wizard (`seepient setup`)** connected directly to the live catalog with multi-credential entry and zero settings data-loss, **native OAuth provider sign-in** for subscription accounts (Claude Pro/Max, OpenAI Codex, GitHub Copilot, OpenRouter, Kimi, xAI), and complete **cross-surface parity** across the CLI, HTTP server, WebSocket, and SDK.

---

### 🔧 What's New

#### 1. Shared ModelPicker & Searchable Model Browser (Spec 013 M2)
* **Search-as-you-Type**: Responsive, synchronous filtering across ~1,267 models from the community catalog by provider, model name, or account ID.
* **Provider-Grouped Windowed Display**: Clean, high-performance rendering that stays silky smooth across large model collections.
* **Reachability Gating**: Models from unconfigured providers are visually dimmed with a direct `[1] Connect provider` affordance; filter reachable models with `[3] Reachable only`.
* **Reasoning / Thinking Effort Sub-Mode**: Select thinking effort levels (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) dynamically constrained to only what the chosen model supports.
* **Session-Only Model Switching**: Test models for the current conversation with `[2] Try for this session` without overwriting persisted job assignments.
* **Pricing & Context Badges**: Live USD input/output per million tokens pricing and context window metrics displayed per row.

#### 2. Rebuilt ModelManager Dock (`/models`) (Spec 013 M2/M4)
* **Interactive Purpose × Tier Jobs Board**: Visual staffing board for all language purposes (`text`, `plan`, `coding`, `vision`, `commit`) across `standard`, `complex`, and `efficient` tiers, plus single-slot media purposes (`media.image`, `media.speech`, `media.transcription`, `media.video`).
* **Transparent Fallback Chains**: Filled/empty slot markers display fallback chains (`standard` → `efficient` → `complex` → unconfigured) so fallback routing is never a mystery.
* **Capability Mismatch Detection**: Flags mismatched assignments (e.g. assigning a text-only model to a vision purpose) with actionable guidance.
* **In-App Provider Account Lifecycle**: Add accounts (paste key, env var reference, keyless endpoint, or OAuth), delete accounts with slot-impact warnings, test connectivity/credentials via live probe, and refresh custom endpoint models directly within the TUI.
* **Live Serving Status**: Status tab showing active turn model, thinking level, session switch state, and token cost breakdown.

#### 3. Rebuilt First-Run Setup Wizard (`seepient setup`) (Spec 013 M3)
* **Catalog-Native Onboarding**: Replaces the legacy 4-provider checkbox with live searchable provider discovery across dozens of providers (OpenAI, Anthropic, Google Gemini, xAI, OpenRouter, Mistral, DeepSeek, local Ollama, etc.).
* **Multi-Mode Credential Configuration**: Setup accounts via pasted API keys, environment variable references, keyless local endpoints, or official provider OAuth sign-in.
* **Real Main Model Selection**: Search and assign the default main model (`text.standard`) with verified pricing and context data—no discarded answers or hardcoded default model maps.
* **Safe Settings Persistence**: Rebuilt "Extras" step (SMTP email, Tavily search, notification webhooks) powered by `SettingsManager.set()`, completely fixing the legacy bug where declining extras wiped `~/.seepient/setting.json`.
* **Smart Re-run Logic**: Automatically skips satisfied steps when re-running setup.

#### 4. Provider Sign-in via OAuth Subsystem (Spec 013 M5)
* **Subscription Login without API Keys**: Official provider sign-in for Anthropic Claude Pro/Max, OpenAI Codex, GitHub Copilot, OpenRouter, Kimi, xAI, and Radius.
* **Dual Flow Support**: Automatic browser authorization with local callback server or in-terminal device code flow with manual URL fallback.
* **Seamless Token Rotation**: Background token refresh managed through the serialized credential store without user intervention.
* **Strict Security & Redaction**: OAuth tokens are stored strictly as `oauth` records in the system keychain/credential store; zero token material is ever written to configuration files, UI state, logs, or error traces.
* **Composer Commands**: Quick sign-in and sign-out directly from chat via `/login [provider]` and `/logout [account]`.

#### 5. ProviderManagerApi Controller & Cross-Surface Parity (Spec 013 M6)
* **Single Semantic Core**: `ProviderManagerApi` controller powers TUI, CLI, Server, WebSocket, and SDK with uniform validation, OCC revision guards, SSRF protection, and error mapping.
* **CLI Power**: New and modernized CLI commands:
  - `seepient models browse [query] [--json] [--reachable-only]`
  - `seepient models resolve <purpose.tier> [--json]`
  - `seepient models set`, `fallback`, `status`, `probe`, `discover`
  - `seepient providers add/edit/remove/list`
  - `seepient auth login/logout/issue-token`
* **REST & WebSocket Parity**: Scoped endpoints for reachability-aware catalog listings (`GET /v1/models/catalog`) and server-side OAuth sign-in relay (`POST /v1/providers/{id}/oauth/start|complete`).
* **SDK v2 Instance Methods**: Full programmatic provider management on `Seepient` instances (`addProvider`, `removeProvider`, `setAssignment`, `clearAssignment`, `resolve`, `getCatalog`).
* **Golden Parity Testing**: 100% test-backed semantic equivalence across all four interfaces.

#### 6. New Bundled Agent Skills
* **`how`**: Step-by-step system operation and process exploration skill with critic, explainer, and explorer prompts.
* **`why`**: Deep root-cause investigation skill backed by formal epistemics and multi-source playbooks for Datadog, Sentry, Linear, Notion, Databricks, Slack, and Code Archaeology.
* **`repo-review-ultra-deep` & `repo-review-ultra-deep-lite`**: Evidence-backed repository and PR architecture and security audits.
* **`unslop`**: Writing optimization skill to cut AI tells and improve readability.

#### 7. Greenfield Demolition & Zero Legacy Baggage
* Demolished dead `model-selector.tsx`, legacy `handleModelsCommand`, `defaultModelMap`, and stale purpose literals.
* Extended `no-legacy-imports` regression test suite to strictly prohibit legacy provider structures or deprecated model identifiers in `src/`.

---

### 🚀 How This Improves Your Experience

| Area | Before (v0.4.4) | Now (v0.5.0) | Why It Matters |
| :--- | :--- | :--- | :--- |
| **Setup Wizard** | Hardcoded 4-provider checkbox; wiped settings on exit | Live searchable catalog, multi-credential entry, zero data-loss | Connect any provider in under 60 seconds with 100% config safety |
| **Model Selection** | Blind cycling list with no search or pricing | Search-as-you-type ModelPicker with prices, context, & reasoning levels | Find and assign the exact model you need in seconds |
| **Provider Accounts** | Read-only TUI tab pointing to terminal commands | Full in-app account management (Add, Delete, Probe, Refresh) | Manage all API keys and local endpoints without leaving the app |
| **Subscription Login** | Manual API key creation & paste only | "Sign in with provider" (OAuth device code & browser auth) | Use Claude Pro/Max or Copilot subscriptions without generating API keys |
| **Surface Parity** | Disparate commands and behaviors across CLI/Server/SDK | Single `ProviderManagerApi` semantic core across all 4 surfaces | Same vocabulary, same reachability, and same outcomes everywhere |
| **Temporary Testing** | Overwrote saved assignments to test a model | "Try for this session" temporary switch | Explore models freely without losing your tuned job assignments |

---

### 🚀 Upgrade

| How you installed | Action |
| :--- | :--- |
| npm | `npm install -g seepient@latest` |
| Homebrew | `brew upgrade seepient` |
| pnpm | `pnpm add -g seepient` |

---

### Technical Details

### Added

* **Shared ModelPicker (`src/ui/tui/components/model-picker.tsx`)**: Dedicated search bar, windowed rendering, reachability dimming, dynamic thinking effort levels, pricing/context metadata, and session-only switch.
* **Rebuilt ModelManager Dock (`src/ui/tui/overlays/model-manager.tsx`)**: Purpose × Tier jobs board with fallback chain rendering, capability mismatch warnings, in-app Provider account CRUD, live probe testing, and serving status tab.
* **Guided Setup Wizard (`src/ui/tui/setup-wizard.tsx`)**: Standalone Ink onboarding flow with live catalog search, multi-credential configuration, account naming, main model assignment, and non-destructive extras setup via `SettingsManager`.
* **OAuth Provider Sign-in Subsystem (`src/vendors/pi-ai/pi-auth-adapter.ts`)**: Flow bridges for Anthropic, OpenAI Codex, GitHub Copilot, OpenRouter, Kimi, xAI, Radius; automatic token refresh; `PersistedCredentialRecord` `oauth` record kind; composer `/login` and `/logout` commands.
* **ProviderManagerApi Controller (`src/transport/cli/provider-manager-api.ts`)**: Single semantic core for provider, account, slot, and catalog operations with sanitized credential states, OCC retry-once, and SSRF validation.
* **Cross-Surface Parity**:
  - CLI: `seepient models browse`, `seepient models resolve`, updated `models status|probe|discover`, `providers add|edit|remove|list`, `auth login|logout`.
  - HTTP Server: `GET /v1/models/catalog` with reachability, `POST /v1/providers/{id}/oauth/start|complete` code relay.
  - WebSocket: Synchronized provider management actions over WS stream.
  - SDK: Programmatic instance methods (`addProvider`, `removeProvider`, `setAssignment`, `clearAssignment`, `resolve`, `getCatalog`).
  - Golden Parity Tests (`src/transport/__tests__/golden-parity.test.ts`).
* **Bundled Skills (`skills/`)**: `how`, `why` (with epistemics and investigation playbooks), `repo-review-ultra-deep`, `repo-review-ultra-deep-lite`, `unslop`.

### Changed

* **TUI App Composition Root (`src/ui/tui/app.tsx`)**: Rebuilt overlay management with `ProviderManagerApi`, integrated `/login`, `/logout`, `/setup` commands, and removed dead model options props.
* **CLI Setup & Bootstrap (`src/transport/cli/setup.ts`, `bootstrap.ts`)**: Rewired `seepient setup` to the Ink `SetupWizard` and updated non-interactive guidance messages.
* **REPL `/models` (`src/transport/cli/commands/models.ts`)**: Rerouted interactive `/models` command to the standalone ModelManager dock.

### Removed

* **Dead UI Artifacts**: Deleted obsolete `src/ui/tui/overlays/model-selector.tsx`, legacy `handleModelsCommand`, `defaultModelMap`, and hardcoded provider list constants.
* **Legacy Imports**: Cleaned up all legacy import paths and extended `no-legacy-imports.test.ts` to strictly prohibit legacy provider menus or deprecated model IDs.

---

## [v0.4.4] - 2026-08-21

**Seepient v0.4.4** is a major architectural milestone introducing the **Provider Management Redesign (Spec 010)** and a complete greenfield modernization of the entire inference and model routing stack. This release replaces static SDK singletons with an instance-scoped `ProviderRuntime`, composable `AggregateInferenceAdapter`, declarative Purpose × Tier routing, August 2026 baseline models with dynamic upstream catalog discovery, multi-target resilience with circuit-breaker cooldowns, real-time cached token and reasoning cost accounting, hardened SSRF guards, durable `0600` audit logging, and instance-first SDK v2. All legacy v1 provider baggage, obsolete flags, and dual execution branches have been cleanly removed.

---

### 🔧 What's New

#### 1. Unified Provider Management & Purpose × Tier Routing (Spec 010)
* **Instance-Scoped Runtime**: Single unified `ProviderRuntime` powering CLI, TUI, REPL, HTTP server, WebSocket, and SDK.
* **Declarative Purpose × Tier Matrix**: Route requests across `text`, `vision`, `plan`, `commit`, and `media` (image) purposes with `standard`, `complex`, and `efficient` tiers.
* **Vendor Inference Adapters**: Composable vendor backends (`PiLanguageRaw`, `PiImageRaw`, `GoogleImageRaw`, `OpenAIImageRaw`, `OmpCatalogSource`) isolated under `src/vendors/`.

#### 2. August 2026 Baseline & Live Upstream Discovery
* **Updated Model Baselines**: Default assignments updated to latest generation models (`gpt-5.6-terra`, `claude-sonnet-5`, `gemini-3.7-flash`, `glm-5.3`).
* **Zero Self-Maintained Model Lists**: Dynamic model catalog discovery powered by `@earendil-works/pi-ai` 0.84.2 and lazy upstream enrichment via `@oh-my-pi/pi-catalog`.
* **Active Upstream Polling**: Live `/models` endpoint probing across configured provider accounts with automatic alias normalization.

#### 3. Multi-Target Retries, Fallbacks & Circuit-Breaker Cooldowns
* **Ordered Fallback Traversal**: Transparently routes through fallback candidate chains (`[selectedTarget, ...failureTargets]`) on transient API failures or rate limits.
* **Circuit-Breaker Cooldown Tracking**: Per-`(account, capability)` cooldown states with jittered exponential backoff and strict ≤240s total execution budget.
* **Streaming No-Replay Protection**: Prevents duplicate partial message replay during mid-stream recovery.

#### 4. Cost Accounting & Reasoning Token Metrics
* **Multi-Dimensional Token Metrics**: Live tracking of input, output, cached prompt, and reasoning/thinking tokens.
* **Dynamic Pricing Calculation**: Real-time USD cost calculation calculated from live catalog pricing data.

#### 5. Hardened Security & Isolation
* **SSRF Guarding**: Robust IP/DNS validation rejecting private loopback, link-local, and cloud metadata reflections (`0.0.0.0/8`, `127.0.0.0/8`, `::1`, `169.254.169.254`) with explicit per-provider opt-in (`ssrfAllowPrivate`).
* **Durable 0600 Audit Log**: Append-only `~/.seepient/audit.log` with `0600` file permissions, `O_NOFOLLOW` symlink rejection, centralized secret redaction, and `fsync` before mutation commits.
* **Atomic TOCTOU Locks**: Lockfile-protected storage mutations with automatic stale-lock self-healing.

#### 6. Surface Parity & Instance-First SDK v2
* **CLI Management**: New first-class CLI commands: `seepient models list|set|fallback|status|discover`, `seepient providers add|edit|remove|list`, and `seepient auth login|logout|issue-token`.
* **REST v2 & WebSocket Parity**: Scoped management endpoints (`/v1/providers`, `/v1/models`) supporting `If-Match` revision concurrency, `ETag` caching, 1MB payload limits, and WebSocket `writeMutex` stream synchronization.
* **SDK v2 (`createSeepient`)**: Programmatic entry point with lifecycle hooks, turn-scoped skill switching, and clean resource disposal.

#### 7. Clean-Slate Greenfield Cleanup
* **Zero Legacy Baggage**: Complete removal of legacy `LLMProvider` base classes, static provider singletons, obsolete config bridges, and dual execution branches.
* **Strict Boundary Enforcement**: Enforced `no-legacy-imports` regression test guard across the entire codebase.

---

### 🚀 How This Improves Your Experience

| Area | Before (v0.4.3) | Now (v0.4.4) | Why It Matters |
| :--- | :--- | :--- | :--- |
| **Model Routing** | Hardcoded provider singletons | Purpose × Tier routing (`text.standard`, `plan`, `media`) | Seamlessly match tasks to the best model & tier |
| **Catalog & Models** | Static model enum lists | Dynamic upstream discovery (`pi-catalog`) | Instant access to new models without software updates |
| **Reliability** | Fails on API rate-limit/error | Auto-fallback traversal & circuit-breaker cooldowns | Uninterrupted agent runs during provider outages |
| **Cost Tracking** | Basic input/output token counts | Input, output, cached prompt, & reasoning accounting | Full visibility into exact usage and dollar cost |
| **Security** | Standard network requests | SSRF metadata guards & 0600 fsync audit logging | Enterprise-grade safety for local and cloud workflows |
| **SDK & Server** | Static functions | Instance-scoped `createSeepient` + REST v2 ETag APIs | Clean lifecycle control, test isolation, & concurrency |

---

### 🚀 Upgrade

| How you installed | Action |
| :--- | :--- |
| npm | `npm install -g seepient@latest` |
| Homebrew | `brew upgrade seepient` |
| pnpm | `pnpm add -g seepient` |

---

### Technical Details

### Added

* **Provider Management Redesign (Spec 010)**: Unified, production-grade provider management architecture replacing static SDK instances with instance-scoped `ProviderRuntime` and composable `AggregateInferenceAdapter`.
  - **Purpose × Tier Routing**: Declarative mapping for language, vision, plan, commit, and image purposes with standard, complex, and efficient tiers.
  - **August 2026 Models Baseline**: Default assignments updated to `gpt-5.6-terra`, `claude-sonnet-5`, `gemini-3.7-flash`, and `glm-5.3`.
  - **Multi-Target Retries & Circuit-Breaker Cooldown**: Automatic ordered fallback traversal (`[selectedTarget, ...failureTargets]`) with per-`(account, capability)` cooldown tracking, strict streaming no-replay protection, and a ≤240s worst-case budget.
  - **Usage & Cached Token Cost Accounting**: Accurate usage metrics and cost calculation tracking distinct input, output, cached prompt, and reasoning token dimensions.
  - **Durable 0600 Audit Log**: Append-only `~/.seepient/audit.log` with `0600` permissions, `O_NOFOLLOW` symlink rejection, centralized secret redaction, and `fsync` before mutation commits.
  - **SSRF Validation & Security**: Hardened IP/DNS resolution preventing local loopback / metadata reflection (`0.0.0.0/8`, `127.0.0.0/8`, `::1`, `169.254.169.254`) with server-controlled private network bypass flags.
  - **REST v2 Management API & WebSocket Integration**: Scoped management endpoints (`/v1/providers`, `/v1/models`) supporting `If-Match` revision concurrency, `ETag` headers, active `/models` upstream polling, 1MB payload limits, and WebSocket `writeMutex` synchronization.
  - **Instance-First SDK v2**: Async `createSeepient()` factory with lifecycle event hooks, stream cleanup, and explicit `dispose()`.

### Changed

* **Agent Loop**: Single execution path wired to `ProviderRuntime` and `AggregateInferenceAdapter` with turn-scoped skill switching and strict `providerAccount` preservation.
* **CLI & TUI**: Rewired CLI bootstrap, setup wizard, REPL `/models`, and TUI provider account mappings to v2 runtime.
* **Settings & Config**: Base configuration rewired to dynamic v2 environment synthesis with zero static model arrays.

### Removed

* **Legacy Provider Core**: Demolished legacy `LLMProvider` abstract classes, static provider singletons, v1 config adapters, and obsolete settings dot-keys.
* **Legacy Imports**: Cleaned up all legacy import paths and added `no-legacy-imports` regression test enforcement.

---

## [v0.4.3] - 2026-08-14

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

---

## [v0.4.2] - 2026-08-01

**Seepient v0.4.2** is a quick fix for the Homebrew install. v0.4.1 bumped `js-yaml` to a version that was published just hours before release, which Homebrew's freshness check (`--min-release-age`) rejected — so `brew install seepient` failed for everyone on v0.4.1.

This release pins `js-yaml` to an older, stable version so the Homebrew install works cleanly. Nothing else changed.

---

### 🔧 What's New

#### Fixed
* **Homebrew Install Broken in v0.4.1**: Pinned `js-yaml` to `4.3.0` (released 2026-06-26). v0.4.1 allowed `^4.3.1`, but `4.3.1` was only hours old — too fresh for Homebrew's minimum-release-age filter, which caused `brew install seepient` to fail with `ETARGET: No matching version found for js-yaml@^4.3.1`. The pin resolves both the Homebrew failure and the project's own supply-chain policy.

---

### 🚀 Upgrade

| How you installed | Action |
| :--- | :--- |
| npm | `npm install -g seepient@latest` |
| Homebrew | `brew upgrade seepient` |
| pnpm | `pnpm add -g seepient` |

If you were stuck on v0.4.1's failed Homebrew install, this fixes it.

---

## [v0.4.1] - 2026-08-01

**Seepient v0.4.1** is a quick follow-up to v0.4.0. It tightens up how Seepient gets installed, clears out the security warnings that piled up under the hood, and fixes the install docs so new users don't trip on the way in.

If you're already on v0.4.0, this is a safe, low-risk upgrade — no behavior changes, just a cleaner, safer foundation.

---

### 🔧 What's New

#### Smoother, Safer Install
* **Homebrew 6.0 Support**: Seepient's install steps now include the new `brew trust` step that Homebrew 6.0 requires for third-party taps, so installing from the tap works without surprises.
* **Correct Node Requirement**: The docs now correctly state that Seepient needs Node.js 22 or later (it was previously listed as Node 20, which crashes at startup). The Homebrew formula was already fixed in v0.4.0; the README now matches.

#### Under-the-Hood Security & Dependency Updates
* **Security Patching**: Pinned known-vulnerable transitive dependencies (postcss, undici, esbuild, hono, and a few others) to safe versions, clearing the Dependabot alerts flagged on v0.4.0.
* **Dependency Upgrades**: Bumped several direct dependencies to their latest stable releases (js-yaml, nodemailer, ws, the MCP SDK) to stay current and secure.

#### Documentation
* Added an internal runbook covering a Homebrew 6.0 + `json` gem crash that can brick `brew` itself on arm64 Macs, so anyone who hits it has a clear fix path.

---

### 🚀 Upgrade

| How you installed | Action |
| :--- | :--- |
| npm | `npm install -g seepient@latest` |
| Homebrew | `brew upgrade seepient` |
| pnpm | `pnpm add -g seepient` |

No breaking changes. All 925 tests pass on the new dependency set.

---

## [v0.4.0] - 2026-07-31

Welcome to **Seepient v0.4.0**! This release brings a big upgrade to how Seepient talks to you in the terminal and how it safely gets things done on your system.

Instead of plain text walls, Seepient can now build interactive visual widgets right inside your terminal stream—like live charts, data tables, visual forms, and color-coded code diffs. Under the hood, a new security and permission engine keeps your system isolated and safe, giving you control over every command, file edit, and external request before it happens.

---

### 🎨 What's New

#### 1. Interactive Visual Widgets in Your Terminal
Seepient no longer relies on plain markdown text alone. When analyzing code, summarizing data, or asking for input, Seepient now renders rich visual widgets right inside your terminal stream:

* **Interactive Forms**: Fill out text fields, cycle through options, and toggle checkboxes directly in your terminal without typing long command strings — then submit your answers back to Seepient.
* **Visual Data Charts**: View inline bar charts, trend lines, and sparklines to visualize performance data and progress metrics.
* **Structured Data Tables**: Read datasets, file lists, and benchmark results in clean, formatted tables with bold headers and aligned columns.
* **File Trees**: Browse directory structures and file hierarchies visually.
* **Color-Coded Code Diffs**: Preview code changes with added lines shown in green and removed lines in red before they land on disk.
* **Status Grids & Preview Cards**: Track active tasks with ok / warn / fail / pending markers, and inspect structured item previews at a glance.

#### 2. Smoother, Flicker-Free Streaming
* **Buffered Rendering**: Terminal output is now throttled to roughly 30 frames per second, so the screen no longer flickers while text streams in quickly.
* **Stable Widget Display**: Visual widgets no longer rebuild on every keystroke, so the stream stays readable even during long replies.

#### 3. Built-in Security, Sandboxing & Data Privacy
* **Smart Permission Prompts**: Whenever Seepient needs to run a command or touch a file, it shows a clear prompt explaining what it wants to do and why. You can allow it once, for the current session, for this project, everywhere, or deny it.
* **Remembered Approvals**: Approvals you give are saved securely — project and global ones stick across restarts — so you don't get asked repeatedly for routine, safe operations.
* **Native Process Sandboxing**: Risky shell commands run inside a native OS sandbox — Apple's Seatbelt on macOS and Bubblewrap on Linux — by default. If Seepient can't set up a sandbox, the command is blocked rather than allowed to run loose. *(Container-based isolation for server-driven workflows is built but not switched on in this release; it arrives in a follow-on update.)*
* **Atomic File Edits**: Every edit is fully checked and then written in a single atomic step. If something fails mid-edit, your file is never left half-written or corrupted — the original stays intact.
* **Built-in Privacy Guard**: Before tool results are sent to the AI model, Seepient checks them for sensitive data classes (secrets, credentials, keys, active policy) and holds back anything sensitive, so local passwords and API keys don't slip into the model's view.
* **Tamper-Resistant Audit Trail**: Every permission decision, command run, and file edit is written to a local, append-only audit log with locked-down file permissions — a clear, durable history of everything Seepient did.

#### 4. Direct Control & Management Tools
* **/permissions**: Manage saved permissions, view active rules, and revoke access.
* **/context**: Inspect your current prompt context and token usage budget.
* **/skills**: Browse and manage installed agent skills.

---

### 🚀 How This Improves Your Experience

| Area | Before (v0.3.x) | Now (v0.4.0) | Why It Matters |
| :--- | :--- | :--- | :--- |
| **Terminal Output** | Plain text walls | Live visual widgets (forms, charts, tables, diffs) | Easier to read data and interact naturally |
| **User Input** | Text-only prompts | Visual forms with inputs, checkboxes, & options | Faster, cleaner input without formatting errors |
| **Streaming** | Flickery during fast output | Smooth ~30fps buffered rendering | Comfortable to watch, even in long replies |
| **System Safety** | Runs directly on your machine | Runs in a native OS sandbox (or is blocked) | Safe to run autonomous workflows; untrusted commands can't touch your system |
| **File Editing** | Direct file overwrites | Atomic, all-or-nothing edits | No risk of half-written or corrupted files |
| **Data Privacy** | Raw tool outputs sent to AI | Sensitive outputs held back from the model | API keys & secrets stay private |



### Technical Details

### Added

- **Permission System Redesign R9.1** (#008): Production-ready single-path permission pipeline. Every tool call across CLI, TUI, REPL, SDK, and HTTP/WS routes through `PolicyEngine` → `ApprovalBroker` → `ExecutionBoundary` → `AuditRecorder`.
  - **Fail-Closed Defaults**: Process containment (`ProcessExecutor`) and exact-file commits (`CommitFilesExecutor`) default to fail-closed (`ISOLATION_UNAVAILABLE` and `EXACT_COMMIT_UNAVAILABLE`) when native isolation tools (`Seatbelt` / `Bubblewrap` / Rust commit helper) are absent. JS fallback write requires explicit opt-in (`allowFallback: true` or `SEEPIENT_ALLOW_JS_FS_FALLBACK=1`). Uncontained shell execution requires explicit operator opt-in (`unsafeUncontained: true`).
  - **Monotonic 4-Layer Intersection**: `effectiveCapabilities` strictly enforces maxAuthority = (deployment ∩ principal ∩ runtime) and effective = (maxAuthority ∩ active). User approvals are bound up to deployment and runtime limits without expanding outer ceilings.
  - **Real Process Containment**: Integrated `@anthropic-ai/sandbox-runtime` exact-pinned dependency for native macOS Seatbelt and Linux Bubblewrap process isolation. `probeSandbox` honestly advertises backend support.
  - **Durable Remote Approvals & Replay Protection**: `DurableApprovalStore`, `PersistedCapabilityLedger`, `PersistedReplayLedger`, and `TerminalEventOutbox` persist state with atomic writes (`tmp` + `fsync` + `rename`, `0o600`/`0o700` permissions, file locking with retry loops). WS composition root handles remote approvals durably across socket reconnects.
  - **Server Worker Backend**: `DockerSocketEngine` and `DockerWorkerScheduler` support single-host Docker worker execution with mTLS transport, Ed25519/HMAC signed dispatches, per-tenant workspace mounts, secret-free worker env, and durable replay protection.
  - **Model-Egress Gating**: `ModelEgressGate` evaluates model release for all tool outputs based on the action's declared data classes (`secret`, `active-policy`, `release-key`, `control-plane-credential`), keeping sensitive data out of model-visible history.

- **TUI parity & generative widget upgrade** (#007): Streaming polish (30fps throttle, `React.memo`, cursor hide), ChatBlock lifecycle primitive, `render_widget` tool with 9 kind renderers (table, keyvalue, chart, tree, panel, diff, form, product_card, status_grid), hash-anchored `edit_file` tool (SnapshotStore + parser + patcher with fail-closed stale anchor), enriched Markdown (GFM tables), T4 parity components (thinking indicator, TabBar, plan review overlay, truncated text, toast). Tools count: 13 → 15.
  - **Core**: `src/core/hashline/` — types, parser, patcher, snapshot-store; `WidgetError` + `HashlineError` in `errors.ts`.
  - **Tools**: `src/tools/widgets.ts` (`render_widget`), `src/tools/edit-file.ts` (`edit_file`).
  - **TUI**: `chat-block.ts`, `widget-host.ts`, `stream-flush.ts`, `widgets/` (9 renderers), `components/` (thinking-indicator, tab-bar, plan-review-overlay, truncated-text, toast), `hooks/` (use-cursor).

### Fixed

- **#007 scrutiny fixes**:
  - Widget host recreation on every render → stable `useMemo([], [])`.
  - Widget action keyboard wiring: `useInput` in `WidgetBlock` drives Tab/Enter through the action bar.
  - Hashline multi-op line drift: `sortOpsBottomToTop` ensures ops apply highest-line-first.
  - Hashline stale-anchor data loss: `tryThreeWayMerge` now fails closed (`HASHLINE_STALE_ANCHOR`) instead of silently destroying user content.
  - Widget resume: `feed-serializer.ts` rebuilds `render_widget` as finalized blocks.
  - SnapshotStore 1MB cap, duplicate action bars removed, dead `useBlockCleanup` deleted, `WidgetSpec` consolidated to one source.
  - System prompt: hashline grammar section added (op table, ordering rule, worked example).

- **Design skill** (`skills/design/SKILL.md`): Single bundled entry point for all design work. It is a router/dispatcher — it does not do design itself. On any design request it classifies the task, fetches the matching skill from the upstream OpenDesign catalogue (`https://raw.githubusercontent.com/nexu-io/open-design/main/skills/<slug>/SKILL.md` via `read_website`), maps upstream tool names to Seepient's tools, and follows that skill's procedure with Seepient's quality bar applied on top. Covers 145 verified upstream skills across 13 disciplines (process/brief/review, taste & aesthetic, brand, frontend/web, Figma/design systems, native platforms, slides/decks, image generation, social cards, video/motion, web animation/GSAP/Three.js, documents/editorial, audio). This mirrors how OpenDesign skills cross-reference Anthropic/Gemini design skills — one source of truth upstream, no drift. The new `design` skill brings the bundled-skill count to 13.




## [v0.3.0] - 2026-06-10

Major release adding the **Gateway subsystem** — a universal API hub that makes Seepient act as an MCP client, secure REST proxy, and OpenAPI auto-adapter. This release also includes two security fixes found during code scrutiny, a new middleware pipeline, and 10 new agent-facing gateway tools.

### Added

- **Gateway Engine** (`src/gateway/gateway.ts`): `MCPGateway` class managing target lifecycle, MCP client connections (stdio/SSE/HTTP), REST proxying with credential injection, pattern-based + semantic routing, and lazy reconnect on failure.
- **Semantic Tool Injection** (`src/core/middleware/semantic-tools.ts`): Middleware scores the user's last message against all discovered gateway tools using keyword relevance scoring and injects the top-K most relevant tools directly into the agent's tool context. Falls through to proxy pattern when no matches found.
- **Agent-Loop Bridge** (`src/core/agent-loop.ts`): FinalHandler rebuilds options from `ctx` to capture middleware mutations; inline injected-tools lookup dispatches to injected handlers or falls through to static tool registry. ~21 lines total.
- **10 Gateway Proxy Tools** (`src/gateway/tool-factory.ts`): `gateway_route`, `gateway_call_tool`, `gateway_call_rest`, `gateway_capabilities`, `gateway_read_resource`, `gateway_get_prompt`, `gateway_import_openapi`, `gateway_register_target`, `gateway_audit_log`, `gateway_usage_stats`.
- **OpenAPI Spec Importer** (`src/gateway/openapi-importer.ts`): Fetches OpenAPI specs (JSON/YAML), parses paths/operations, and auto-registers as a REST target. Supports tag filtering and base URL override.
- **Gateway Settings Adapter** (`src/gateway/settings-adapter.ts`): Dedicated file-based storage (`~/.seepient/gateway/`) for targets, credentials, routes, and admin-target registry. Atomic writes with temp-file+rename pattern. Credential files written with `mode: 0o600`.
- **Gateway Settings Schema** (`src/core/settings-schema.ts`): 4 typed settings (`gateway.enabled`, `gateway.semanticTopK`, `gateway.defaultRateLimitPerMin`, `gateway.maxAuditLogs`) in a new "Gateway" category. Env vars: `SEEPIENT_GATEWAY_ENABLED`, `SEEPIENT_GATEWAY_RATE_LIMIT`.
- **Semantic Scorer** (`src/gateway/semantic-scorer.ts`): Zero-dependency keyword-based relevance scoring with 80+ stop words for filtering noise.
- **Gateway REST Routes** (`src/adapters/server/rest-gateway.ts`): 11 REST endpoints under `/v1/gateway/*` for target CRUD, credentials, routes, OpenAPI import, audit logs, and usage stats. Proper auth scoping (`agent:read` for reads, `admin` for mutations).
- **Server-Core Extraction** (`src/adapters/server/server-core.ts`): Extracted `serverGenerateText`/`serverStreamText` from `server/index.ts`. Both accept optional `middleware` parameter for gateway semantic injection.
- **CLI `/gateway` Command** (`src/adapters/cli/commands/gateway.ts`): Full management: list, add, remove, toggle, routes, credentials, audit, usage. Wired into REPL with `gw` alias.
- **SDK Gateway Namespace** (`src/adapters/sdk/index.ts`): Lazy-loaded `gateway.createGateway()` for programmatic gateway creation.
- **GatewayError** (`src/core/errors.ts`): New error class with configurable `retryable` flag and `target` metadata. Configuration errors are non-retryable; transient errors are retryable.
- **Credential Trust Guard** (`src/gateway/gateway.ts`): Agent-registered targets cannot resolve `credential:` env vars or `auth.credentialRef` — only admin-registered targets can. Prevents crafted targets from exfiltrating stored credentials.
- **Injectable Tools Cache** (`src/gateway/gateway.ts`): `getInjectableTools()` caches its result and invalidates on target mutations for performance.
- 14 new unit tests across gateway, settings-adapter, semantic-scorer, tool-factory, and middleware modules.

### Fixed

- **B3 Security: Trust guard gap in credential resolution** (`src/gateway/gateway.ts`): `callRest()` and `connectMcpClient()` SSE/HTTP auth headers resolved `credentialRef` for ALL targets regardless of admin status. A non-admin target could register with `auth.credentialRef` pointing to a stored credential and exfiltrate it via REST calls. Now gated behind `adminTargets.has(targetName)` check.
- **B3 Security: OpenAPI import bypassed trust guard** (`src/gateway/openapi-importer.ts`, `src/gateway/tool-factory.ts`): `importOpenApiSpec()` registered all imported targets with `isAdmin=true`, but the agent-facing `gateway_import_openapi` tool called it directly — letting the agent create admin-registered targets with full credential access. Added `isAdmin` parameter; agent tool now passes `isAdmin: false`.
- **JSON parsing returned 500 instead of 400** (`src/adapters/server/rest-gateway.ts`): All `JSON.parse()` calls in gateway REST handlers were unwrapped — malformed request bodies threw exceptions caught by the outer handler as 500 INTERNAL_ERROR. Extracted `parseJsonBody<T>()` helper that returns 400 BAD_REQUEST on parse failure.
- **TypeScript compilation errors in test files** (`src/core/__tests__/semantic-tools.test.ts`, `src/gateway/__tests__/gateway.test.ts`): Message objects missing required `id`/`timestamp` fields (TS2739); `getAdminTargets` mock returned `string[]` instead of `Set<string>` (TS2322); credential injection tests registered targets without `isAdmin=true`, now correctly aligned with trust guard.

### Changed

- **Tool count**: 12 → 22 built-in tools (10 gateway proxy tools added).
- **Settings count**: 31 → 35 typed settings (4 gateway settings added).
- **Settings categories**: 5 → 6 ("Gateway" category added).
- **Dependencies**: Added `@modelcontextprotocol/sdk` (^1.29.0) and `js-yaml` (^4.2.0).
- Agent loop `finalHandler` now rebuilds options from middleware context (`ctx`) before calling `executeLoop`, capturing injected tool definitions.
- Server `createServer()` initializes gateway at startup when `gateway.enabled` is true, wiring semantic middleware into both REST and WebSocket paths.
- CLI `runChat()` initializes gateway at startup, wires middleware into Agent, and passes gateway instance to command registry.
- `MCPGateway.registerTarget()` validates `kind` field (must be `mcp` or `rest`).
- `MCPGateway.toggleTarget()` now persists the toggled state via settings adapter.
- `MCPGateway.unregisterTarget()` cleans up routes, MCP clients, admin tracking, and injectable tools cache.

### Security

- **Critical**: B3 credential trust guard extended to REST proxy auth headers — agent-registered targets can no longer resolve `credentialRef` to exfiltrate stored credentials.
- **Critical**: OpenAPI import from agent tools now creates non-admin targets; only REST API (admin scope) and CLI create admin targets with full credential access.
- **Medium**: All gateway REST endpoints return 400 (not 500) for malformed JSON request bodies.
- **Low**: Credential files written with `mode: 0o600` on Unix systems.

## [v0.2.2] - 2026-06-10

This release fixes five bugs found during a holistic system audit — two that could silently lose data under real workloads, one that broke SSE streaming order, one that left provider state corrupted after skill execution, and one that made `agent.abort()` a no-op during streaming. Session files are now written atomically, and a brand discriminator on `PersistenceBackend` stops metadata from being stripped when custom backends are passed to `createAgent()`.

### Fixed

- **SSE events arrived out of order** (`stream-manager.ts`): `toSSEStream()` drained the text queue completely before touching the step queue, so consumers saw all text deltas first, then all tool events — even when tools actually ran between text chunks. Added a unified `eventQueue` that preserves the real interleaved order. Text and step streams still work independently for non-SSE consumers.
- **`agent.abort()` did nothing during `chatStream()`** (`sdk/agent.ts`): `chatStream()` created its own local `AbortController`, but `agent.abort()` still called `.abort()` on a stale closure variable. Now tracks a single `activeAbortController` that both `chat()` and `chatStream()` assign before starting the loop.
- **`PersistenceBackend` instances lost metadata on save** (`sdk/agent.ts`, `types.ts`, `session-store.ts`): `wrapAsPersistenceBackend()` couldn't tell `SessionStore` from `PersistenceBackend` — both have a `save` method, so it always wrapped, calling `.save(id, data.messages)` and throwing away `createdAt`, `provider`, `model`, and custom `metadata`. Added a `__persistenceBackend` brand field to the interface and both built-in backends; the wrapper now passes through branded instances untouched. **Breaking**: third-party `PersistenceBackend` implementations must add `readonly __persistenceBackend = true as const`.
- **Skill provider switching leaked state after loop exit** (`agent-loop.ts`): `providerFactory.restore()` was only called inside the tool-calls block. On text-only completion, errors, or aborts, the factory stayed in a switched state — the next agent run would start with the wrong provider. Wrapped the entire loop body in `try/finally` so `restore()` runs on every exit path.
- **Concurrent `chat()`/`chatStream()` calls corrupted the message history** (`sdk/agent.ts`): `chatStream()` runs the agent loop in a background IIFE and returns immediately. Nothing prevented a second call from starting while the first was still mutating the shared `messages` array — no lock, no guard. Added a promise-based `acquire()`/`release()` lock that serializes all chat operations. A second call blocks until the first completes.
- **Session files were not written atomically** (`session-store.ts`): `FilePersistenceBackend.save()` used a bare `fs.writeFile()` — a crash mid-write left a corrupt JSON file. Now writes to a temp file first, then renames to the target path, matching the atomic pattern already used by `SettingsManager`.
- **Middleware errors left no audit trail** (`agent-loop.ts`): When outer middleware (auth, rate-limit) threw, the error was caught and returned as a structured result, but nothing was logged. Added a `console.error` in the middleware catch block so rejected requests show up in server logs.

### Changed

- Redesigned `/settings` interactive mode into a 3-level drill-down wizard with bordered ASCII headers and mini-forms.
- Reorganized settings categories from 6 to 5: Providers & Models, Permissions & Safety, Tools & Integrations, Notifications, Skills.
- `/settings` with no arguments now launches the wizard (was a plain list).
- Removed `/settings edit` and `/settings wizard` subcommands.
- All 12 built-in tools now carry a `risk` field (`safe`, `edit`, `communications`, or `destructive`).
- `--headless` flag replaces the binary `SEEPIENT_SHELL_APPROVE` approval mechanism.
- Unknown and custom tools default to `destructive` risk category, requiring approval in all modes except `permissive`.
- `ToolModule` interface now includes optional `risk` field.
- `permissionMode` option removed from `AgentCreateOptions` (replaced by `permissionLevel`).

### Added

- `/setup` slash command to access the setup wizard directly.
- Bordered mini-form with type-appropriate prompts (password masking, enum lists, boolean confirms).
- Env var override warnings in the setting editor.
- Number field validation with min/max constraints.
- **Permission Levels System**: 3-tier permission matrix (strict/moderate/permissive) with 4 tool risk categories (safe/edit/communications/destructive) controlling which tools auto-execute vs. require human approval.
- CLI flags: `--headless`, `--strict`, `--moderate`, `--yolo` for controlling tool approval behavior.
- SDK: `permissionLevel` option on `GenerateTextOptions`, `StreamTextOptions`, and `AgentCreateOptions`.
- Server: per-message permission level with `maxPermissionLevel` ceiling per connection.
- `SEEPIENT_PERMISSION` environment variable and settings file support for default permission level.
- `src/core/permission.ts` — Permission matrix with 3 pure functions (`needsApproval`, `resolvePermissionLevel`, `getToolRiskCategory`).
- 12 built-in tools categorized by risk; custom tools default to "destructive" (deny-by-default).
- 25 new tests (22 in `permission.test.ts`, 3 in `tool-executor.test.ts`).
- **Settings System**: Schema-driven settings management with CLI, SDK, and Server adapters.
- `src/core/settings-schema.ts` — 37 settings mapped to AppConfig paths with validation metadata, env var overrides, and category grouping.
- `src/core/settings-manager.ts` — SettingsManager with get/set/reset/list/onChange, secret masking, origin resolution, atomic file persistence, and deep merge for provider configs.
- CLI `/settings` command with subcommands: `list`, `get`, `set`, `reset`, `edit`, `wizard`, `export`, `help`. Aliases: `/config`, `/setting`.
- SDK `settings` facade exporting get/set/apply/list/listByCategory/onChange/reset/resetAll.
- Server REST endpoints: `GET/PATCH /v1/settings`, `GET /v1/settings/schema`, `POST/PATCH/DELETE /v1/providers`.
- Server WebSocket message types for settings get/update/change broadcast.
- 58 new tests (30 unit + 28 integration) covering schema, manager, validation, persistence, events, and secret masking.

### Security

- **Critical**: WebSocket tool approvals are now bound to the originating connection, preventing cross-connection approval bypass.
- **High**: `autoConfirm` state is captured immutably at agent construction time, preventing runtime mutation attacks.
- **High**: Tool denial messages use generic text ("Tool execution denied.") to prevent information leakage.
- **Medium**: Unknown permission level values are validated in server ceiling comparison, preventing ceiling bypass via invalid levels.
- **Medium**: Custom tool registry is included in risk lookups alongside built-in tools.
- **Low**: Conflicting `--headless` and permission level flags produce a warning.
- **Low**: Legacy `SEEPIENT_SHELL_APPROVE` env var is ignored when new permission flags are active.

## [v0.2.1] - 2026-04-09

### Fixed
- Corrected Homebrew formula SHA256 checksum to match npm-published tarball.

## [v0.2.0] - 2026-04-09

### Added

- **Skills System**: Loadable skill packs with `@path` references, workspace setup, and built-in skills (docker-ops, k8s-deploy, log-analyzer).
- **SDK (Programmatic API)**: Full TypeScript SDK with `createAgent`, `streamText`, `generateText`, structured output, React hooks, and session persistence.
- **Server Adapter**: Standalone HTTP/WebSocket server with REST API, session management, and authentication (API key + bearer token).
- **Docker Support**: Production-ready Dockerfile, `.dockerignore`, `docker-compose.yml`, `--docker` CLI flag, and non-interactive environment detection.
- **Shell Approval Modes**: Dual-mode shell command approval — interactive inquirer prompt and non-interactive `SEEPIENT_SHELL_APPROVE` env var with `auto`/`deny` modes.
- **Standalone Server Binary**: `seepient-server` with `--generate-api-key` flag, env var configuration, and graceful shutdown.
- Environment variable overrides for provider API keys.
- VitePress documentation site.

### Changed

- **Modular Multi-Adapter Architecture**: Restructured from monolithic `index.ts` into `core/`, `adapters/{cli,sdk,server}/`, `providers/`, `skills/`, `tools/`.
- **Unified Core**: Shared agent loop, provider resolver, tool executor, error hierarchy, and hooks system across all adapters.
- Extracted error hierarchy into `src/core/errors.ts`.
- Extracted tool executor into `src/core/tool-executor.ts`.
- Split CLI adapter into focused modules (`agent.ts`, `config-loader.ts`, `setup.ts`, `index.ts`).
- Standardized `OPENAI_COMPAT_*` environment variables.
- Updated default models catalog.
- Session store with filesystem backend for persistent session management.

### Fixed

- Corrected parentheses in provider resolution logic.

### Removed

- Monolithic `src/index.ts` entry point (replaced by modular architecture).
