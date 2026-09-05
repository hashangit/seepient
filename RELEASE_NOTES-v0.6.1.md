# Seepient v0.6.1 release notes

Seepient v0.6.1 introduces stateless SDK workers with pluggable store injection, unified SDK ergonomics under `createSeepient`, a production-hardened Docker container with built-in headless browser automation, and modernized provider configuration.

### Highlights

#### 1. Stateless SDK workers and external storage (Spec 021)
Platforms and enterprise applications can now embed Seepient completely statelessly. Instead of relying on local disk storage, embedders can inject custom store implementations directly into `createSeepient`, `generateText`, `streamText`, or `createServer`:
- `auditStore`: Route structured audit events directly to your centralized logging service or database.
- `policyStore`: Evaluate custom authorization and permission rules stored in external policy engines.
- `capabilityLedger`: Track and persist active grants and security leases remotely.
- `sessionStore`: Manage multi-tenant session state in Redis, PostgreSQL, or DynamoDB.
- `runtime`: Supply custom provider runtimes and catalog routing.

When all stores are injected, Seepient operates with zero disk writes to the host filesystem, making it suitable for serverless functions, multi-tenant agent fleets, and ephemeral container tasks. A runnable reference worker implementation is available in `examples/worker/`.

#### 2. Unified SDK consolidation
Programmatic usage is now unified around `createSeepient` with consistent permission enforcement and thread-safe execution:
- **Single governed entry point**: `createSeepient` replaces legacy entry points, routing all agent interactions through the permission pipeline and execution boundary by default.
- **Turn concurrency safety**: Replaced shared lock resolvers with a chained promise mutex. Concurrent calls to `agent.chat()` queue cleanly and execute in order without race conditions or hung sessions when turns abort.
- **Clean method surface**: Standardized on `chat`, `chatStream`, `getHistory`, and `switchProvider`, removing obsolete legacy alias methods.
- **Fail-closed custom tool effect checks**: Custom tools declaring effects (`network-egress`, `secret-use`, `model-egress`) now strictly validate destinations and secret references at registration time, catching configuration mistakes before execution starts.

#### 3. Production Docker runtime
The container setup in `Dockerfile` and `docker-compose.yml` has been updated for production standalone server and worker workloads:
- **Built-in headless browser**: Includes system Chromium (`/usr/bin/chromium`) configured for Playwright, removing the need for post-install browser downloads.
- **CJK and emoji typography**: Pre-packages `fonts-noto-cjk` and `fonts-noto-color-emoji`, ensuring screenshots and web capture render Chinese, Japanese, Korean, and emoji characters without missing glyphs.
- **Native commit verification**: Compiles and bundles the native `seepient-fs-commit` helper binary directly inside the container for exact atomic file writes.
- **Hardened container defaults**: Runs as non-root `appuser` (UID 1001) under `dumb-init` PID 1 process supervision, with explicit volumes for persistent sessions, custom skills, and workspace directories.

#### 4. Dynamic skill registry threading
Fixed an issue where runtime skill imports did not propagate to subagents or loop callbacks. Skills discovered at runtime are now dynamically bound to `use_skill` across the entire turn lifecycle.

#### 5. Streamlined provider setup and credential security
- **Zero-config auto-discovery**: Seepient detects standard environment variables (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`, `GROQ_API_KEY`, `GLM_API_KEY`) at startup with no initial setup required.
- **Interactive management**: Run `seepient setup` for guided onboarding, or open `/models` (`Ctrl+M`) in the TUI to browse live catalogs and manage tiered assignments visually.
- **Flexible credential storage**: Bind accounts to OS Keychain, OAuth subscription sign-ins, custom environment variables, or local endpoints with no authentication.
- **Legacy configuration cleanup**: Removed obsolete `OPENAI_COMPAT_*` keys and deprecated compatibility shims.

#### 6. Security and dependency updates
- Upgraded `js-yaml` (4.3.2), `fast-uri` (3.1.6), `hono` (4.13.5), and `qs` (6.16.0) to remediate transitive security advisories.
- Added automated CodeQL analysis and production dependency audit checks to CI release gates.
