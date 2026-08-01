# Context

**Current Task**: Spec 011 (tui-permission-scope-ux) — COMPLETE on branch
`011-tui-permission-scope-ux`. Spec 008 shipped earlier (see below).

## Status
- 21/21 tasks complete (T001–T025). 951/951 tests pass across 99 files; both
  strict typechecks green; release build (`tsc`) green.
- Native typed TUI approval bridge: `PolicyEngine` issues `approvalOptions`
  (exact/bounded) + action/session lifetimes on `PermissionRequest`; TUI
  `PermissionPrompt` renders Scope/Duration tabs with least-privilege defaults
  and keyboard nav; `InlineApprovalBroker` enriches `TuiApprovalSelection` with
  actor/timestamp; `ActionLifecycle` validates option/lifetime/expiry/revocation
  and issues the final envelope from the selected option's capabilities (Allow
  Once consumed once, never retained; This Session retained until revocation).
- Legacy flag-off prompt unchanged; non-TUI surfaces keep legacy adapters but
  bind approvals to the narrowest request option.

## Key Decisions
- Envelope = selected option's capabilities + pre-covered required caps (keeps
  model-egress gate working for pre-authorized egress).
- Bounded options offered only for backend-enforceable shapes (process
  executable-bound, read-root); no write-root bounded options in MVP (commit
  broker is exact-only).
- `PolicyContext.sessionId` added; `session` lifetime offered only when a stable
  session identity exists.

## Next Steps
- Interactive quickstart S1–S5 (manual TUI session with a real provider).
- `/permissions` admin flow remains the documented route for persistence.
