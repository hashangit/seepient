## [0.4.4] - 2026-08-21

**Seepient v0.4.4** is a major architectural milestone introducing the **Provider Management Redesign (Spec 010)** and complete greenfield modernization of all inference layers. This release replaces all static SDK instances and legacy provider adapters with an instance-scoped `ProviderRuntime`, composable `AggregateInferenceAdapter`, declarative Purpose × Tier routing, live upstream catalog discovery, multi-target resilience with circuit-breaker cooldowns, accurate cached token and reasoning cost calculation, durable `0600` audit logging, and instance-first SDK v2. All legacy v1 provider baggage, obsolete flags, and dual execution branches have been completely eliminated.

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
