# Context

**Current Task**: Spec 011 (tui-permission-scope-ux) — implemented, two review
rounds fixed, on branch `011-tui-permission-scope-ux` (commits `136d233`,
`bd9f773`, + review-fix commits).

## Status
- 24/25 tasks complete. T025 (quickstart manual scenarios S1–S5) is PENDING:
  it requires a human-driven interactive TUI session with a real provider.
- 964/964 tests (100 files), both strict typechecks, release build — all green.
- Round-2 review findings all fixed with regression tests:
  - P0: brokers get a deeply frozen clone of the request; Domain validates
    against the pristine snapshot — request mutation can no longer widen an
    approval (mutation throws, round-trip fails closed).
  - P1: production WS requests now carry a representable exact option
    (empty capabilities — the legacy loop stays the authority), so WS
    approvals can succeed and the durable record matches execution.
  - P1: already-aborted signals deny immediately instead of stalling until
    the deadline.

## Not Done (honest record)
- T025: interactive quickstart S1–S5 not executed (needs a terminal + real
  provider). Every behavior has an automated equivalent test.
- When the P4 server split lands, WS legacy requests should be replaced by
  engine-issued options (documented in `wsLegacyApprovalRequest`).

## Key Decisions
- Envelope = selected option's capabilities + pre-covered required caps.
- Bounded options only for backend-enforceable shapes (process
  executable-bound, read-root).

## Next Steps
- Run quickstart S1–S5 manually; mark T025 complete; then merge.
