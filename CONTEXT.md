# Context

**Current Task**: Spec 011 (tui-permission-scope-ux) — implemented and
review-fixed on branch `011-tui-permission-scope-ux` (committed `136d233`).

## Status
- All 25 implementation tasks done; strict typechecks, release build, and
  961/961 tests green (100 files).
- External review (CodeRabbit-style) found 4 code issues; all fixed with
  regression tests: session revocation now binds to the lifecycle session
  identity (P0); broker deadline races the presenter + TUI presenter honors
  the abort signal (P1); WS execution follows the validated typed decision
  (P1); action-lifetime cleanup no longer strips pre-existing active
  authority (P1).

## Not Done (honest record)
- Quickstart manual scenarios S1–S5 (interactive TUI with a real provider)
  were NOT executed — they need a human-driven terminal session. Every
  behavior they check has an automated equivalent test.
- Keyboard coverage: Tab, Shift+Tab, Left/Right, Up/Down, digits, Enter,
  esc/q all have automated ink tests.

## Key Decisions
- Envelope = selected option's capabilities + pre-covered required caps
  (keeps the model-egress gate working for pre-authorized egress).
- Bounded options only for backend-enforceable shapes (process
  executable-bound, read-root); no write-root bounded options in MVP.

## Next Steps
- Run quickstart S1–S5 manually, then mark T025 complete.
