# Seepient v0.5.2 Release Notes

**Seepient v0.5.2** delivers the complete **God-File Decomposition (Spec 015)**, systematically refactoring high-churn transport, UI, and domain modules into modular, single-responsibility siblings. This release eliminates merge collisions across concurrent feature workstreams, caps touched source files under 350 LOC, enforces strict architectural layer boundaries, and preserves 100% backward-compatible public contracts with zero performance or behavior regressions.

---

## 🔧 What's New

### 1. Modular HTTP Provider Management Routes (Spec 015 US1)
- **Decomposed Monolith**: Replaced the 846 LOC `provider-management-handlers.ts` with dedicated route modules under `src/transport/http/provider-management/`:
  - `accounts.ts`: Provider account retrieval, mutation, and removal (`GET /v1/providers`, `PUT /v1/providers/{id}`, `DELETE /v1/providers/{id}`).
  - `assignments.ts`: Purpose × Tier slot assignment management (`GET/PUT/DELETE /v1/providers/assignments/*`).
  - `oauth.ts`: In-memory pending attempt lifecycle with automated expiration cleanup and OAuth endpoints (`/v1/providers/{id}/oauth/start|complete`).
  - `catalog.ts`: Upstream model resolution, reachability-aware catalog queries, provider probing, and custom model refresh.
  - `http-util.ts`: Standardized JSON serialization, OCC conflict inspection (`If-Match`), request body parsing, and deployment mode validation.
- **Direct Caller Wiring**: `src/transport/http/rest.ts` imports route modules directly with zero compatibility shims.

### 2. WebSocket Protocol Split & Connection Registry (Spec 015 US2)
- **Consolidated Connection Registry**: Extracted all module singletons (`activeConnections`, `pendingApprovals`, `durableApprovalStore`) and connection utilities (`getActiveConnectionCount`, `getOtherClients`, `safeSend`, `closeAllConnections`) into `src/transport/ws/connection-registry.ts` to prevent duplicate state and cross-module state leaks.
- **Protocol Siblings by Message Family**:
  - `chat.ts`: Handlers for streaming execution (`chat`) and turn cancellation (`abort`).
  - `approvals.ts`: Resumable tool approval requests, responses, and interactive tool approval broker factory (`createServerApproveTool`).
  - `provider-mutations.ts`: Runtime provider switching and model discovery (`switch_provider`, `list_models`, `list_providers`, `set_provider`, `remove_provider`).
  - `session-control.ts`: Session lifecycle management (`resume`, `reconnect`, `list_skills`, settings mutations).
- **Thin Protocol Dispatcher**: Reduced `src/transport/ws/ws-handlers.ts` to 173 LOC exporting only `handleConnection`.

### 3. Modular TUI Model Manager Dock (Spec 015 US3)
- **Separation of State & Presentation**: Refactored `src/ui/tui/overlays/model-manager.tsx` into a stateful hook and focused presentational components under `src/ui/tui/overlays/model-manager/`:
  - `use-manager-state.ts`: Owns the shared state blob, async loaders, OCC mutations, and centralized keyboard tab-cycling.
  - `jobs-tab.tsx`: Interactive Purpose × Tier slot assignment view and fallback chain display.
  - `providers-tab.tsx`: Configured accounts list with reachability badges and unconnected provider teasers.
  - `now-tab.tsx`: Live turn serving model, active account, thinking level, and session switch indicators.
  - `sign-in-flow.tsx`: Multi-step OAuth authentication flow (browser redirect & terminal device-code).
  - `dialogs.tsx`: Minimal confirmation and thinking effort selection dialogs.
- **Preserved Parent Surface**: `src/ui/tui/overlays/model-manager.tsx` acts as a clean composition root exporting `ModelManager` and `runModelManagerStandalone`.

### 4. Permission Lifecycle Pure Helper Extraction (Spec 015 US4)
- **Atomic Execution Boundary Preserved**: Retained the core `ActionLifecycle` pipeline intact in `src/domain/permissions/action-lifecycle.ts` while extracting private helpers into domain-internal siblings:
  - `deny-reasons.ts`: `KNOWN_DENY_REASONS` set and `typedDenyReason` mapping.
  - `audit-redaction.ts`: `redactAuditCapability` argument sanitization for forensics.
  - `approval-options.ts`: `deepFreeze` immutability helper and `validFor` request binding verification.
- **Zero Export Signature Drift**: Public exports of `action-lifecycle.ts` remain byte-for-byte identical to baseline.

### 5. Architectural & Verification Rigor
- **Layer Boundary Compliance**: Automated validation via `architecture-boundaries.test.ts` asserts strict one-way dependency flow (`UI → Transport → Domain → Capabilities → Vendors → Foundations`).
- **Five Safety Gates Passed**: Verified green across `golden-parity.test.ts`, `ws-approval.test.ts`, `ws-provider-parity.test.ts`, `model-manager.test.tsx`, and all permission suites.
- **Zero File Bloat**: Every touched file in the repository reduced to well under 350 LOC.
