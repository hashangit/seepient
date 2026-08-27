# Seepient v0.5.5 Release Notes

**Seepient v0.5.5** delivers the complete **Permission Tool Baseline & Consent Modes (Spec 017)** along with upstream **`@earendil-works/pi-ai` 0.84.3** synchronization. It fixes the brokered-tool lockout and zero-effect gate bug, establishes auto-granted baseline capabilities for all built-in brokered tools, classifies read-only/planning/in-memory tools as safe zero-prompt operations, replaces the legacy permission levels with three canonical consent modes (`ask-everything`, `edit-enabled`, `autonomous`), adds secret injection and cross-host redirect credential protection in `EffectBroker`, maps `--yes` / `-y` directly to autonomous mode, and completely demolishes the legacy parallel permission code paths across all surfaces.

---

### 🛡️ Highlights & Key Improvements

#### 1. Brokered Tools Baseline & Dynamic Capability Derivation (Spec 017 US1)
* **Default Deployment Ceiling Baseline**: Built-in brokered tools (`generate_image`, `web_search`, `read_website`, `send_email`, `send_notification`, `optimize_prompt`) are auto-granted in the default ceiling policy (`DEFAULT_DEPLOYMENT_CEILING_V2`) and local policy baseline.
* **Dynamic Communication Analyzers**: `send_email` and `send_notification` extract dynamic destinations from tool arguments and configuration (`config.smtpHost`, webhook endpoints) rather than failing closed with missing static grants.
* **Centralized Credential Resolution**: Shared credential resolver ensures settings-file credentials (`~/.seepient/setting.json` and `.seepient/setting.json`) are seamlessly merged with environment variables and injected directly into outbound brokered network requests.
* **Cross-Host Redirect Security**: Outbound HTTP requests automatically strip credentials and reject secret-bearing bodies across cross-host redirects.
* **Setup Failure Result Family**: Missing API keys or unconfigured credentials for brokered tools return structured `SetupFailure` messages with exact setup instructions rather than false authorization failures.
* **Stored Policy Version Migration**: Upgraded on-disk policy version stamp (`CURRENT_CEILING_VERSION = 2`), seamlessly reconciling existing policies with the v2 ceiling baseline without manual intervention.

#### 2. Safe Core Tools (Spec 017 US2)
* **Zero-Prompt Normal Actions**: `get_current_datetime`, `manage_todos`, and `render_widget` emit normal-class actions with `none` operations and normal `model-egress`, allowing them to execute instantly without human approval prompts across all modes.

#### 3. Three Consent Modes & Interactive UX (Spec 017 US3, US4)
* **Canonical Consent Modes**:
  - `ask-everything`: Prompts for every action with external side effects or model egress.
  - `edit-enabled` (default): Pre-approves workspace edits, reads, and normal operations; prompts only for high-risk shell commands and outbound communications.
  - `autonomous`: Executes all actions permitted by the ceiling policy without human prompts.
* **Surface Parity**:
  - CLI: Added `--mode <ask-everything|edit-enabled|autonomous>` startup flag, and mapped `-y, --yes` directly to `autonomous` consent mode.
  - Slash Command: Added `/mode [ask-everything|edit-enabled|autonomous]` with cycle and direct selection.
  - TUI: `Shift+Tab` cycles modes live; real-time `mode: <mode>` indicator in footer; one-time interactive confirmation dialog when switching to autonomous mode.
  - REPL & SDK: Typed options for `consentMode`, `deploymentCeiling`, and `principalPolicy`.

#### 4. Legacy Permission Demolition & Greenfield Single Pipeline (Spec 017 US5)
* **Complete Legacy Removal**: Deleted `permissionLevel`, legacy matrix (`checkToolPermission`), `--strict`, `--moderate`, `--yolo`, `--no-permission-pipeline`, `src/domain/grants.ts`, and `src/domain/permission.ts`.
* **Fail-Closed Domain Action Lifecycle**: The Domain policy pipeline (`PolicyEngine` → `ApprovalBroker` → `ExecutionBoundary` → `AuditRecorder`) is now the sole execution path across CLI, TUI, REPL, SDK, and HTTP/WebSocket server.
* **One-Way Legacy Grant Migration**: Automatically migrates legacy on-disk `grants.json` into canonical, typed capabilities in `LocalPolicyStore`.

#### 5. Upstream AI Dependencies
* **Bump `@earendil-works/pi-ai` to 0.84.3**: Upstream provider enhancements, bug fixes, and telemetry updates.
