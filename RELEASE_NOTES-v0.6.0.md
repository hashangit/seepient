# Seepient v0.6.0 Release Notes

Seepient v0.6.0 delivers custom-tool execution parity (Spec 020), bringing policy-governed `preparedTool` execution, data-only `brokerConnector` dispatch, exact-commit guarantees for CLI image outputs, and hardened parser defenses to the Seepient platform.

---

### Key changes

#### 1. Custom-tool execution parity (Spec 020)
* **`preparedTool` execution pipeline:** Restored `preparedTool` factory and types from the public package entry. Custom author-supplied analyzers return an untrusted `PreparedActionDraft` (`operation`, `effects`, `risk`, `display`), stamped with platform identity and verified via `buildPreparedAction`, executing through the policy engine, consent modes, approval broker, and execution boundary with exact-commit guarantees.
* **`brokerConnector` data-only execution:** Declarative argument-to-request mappings using JSON Pointers (RFC 6901) execute directly against backend brokers (e.g. `web-search`) with zero embedder code execution and construction-guaranteed secret isolation.
* **Explicit trust models:** Public SDK roots (`createAgent`, `generateText`, and `streamText`) support explicit custom tool registrations across all three rungs (`preparedTool`, `brokerConnector`, `trustedHostTool`), gated on `permissionPipeline: true`.
* **Action-aware error guidance:** Custom tool analyzer errors and fail-closed secret resolution (`CONNECTOR_SECRET_UNRESOLVED`) surface exact diagnostic remediation, never misleading ambient `trustedHostAllowlist` hints.

#### 2. CLI image generation exact-commit checks
* **Audited image file writes:** CLI image generation (`generate image`) routes all file writes through `FileCommitBroker` with action-scoped capability envelopes, ensuring all model-authored image outputs receive exact-commit checks and full audit tracking.
* **Domain bridge:** Image commit broker construction and envelope issuance are encapsulated behind a clean Domain seam function (`createCliImageCommitContext`), strictly adhering to architectural layer boundaries.

#### 3. Security hardening & parser defenses
* **JSON Pointer own-property gating:** `resolveJsonPointer` strictly enforces own-property resolution, preventing prototype traversal and blocking inherited properties on Object prototypes.
* **Prototype pollution protection:** Evaluated connector mappings guard against `__proto__`, `constructor`, and `prototype` property injection across both argument bindings and constant values.
* **Generic secret fallback resolution:** `resolveSecretRef` securely resolves declared secrets against credential configurations and standard environment variables.
* **Registration name collision guards:** Custom tool registrations reject collisions with built-in tool names and duplicate custom tool names at composition time.
