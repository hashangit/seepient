# Context

**Current Task**: Spec 011 (tui-permission-scope-ux) — production-hardening
pivot implemented (T026–T035), on branch `011-tui-permission-scope-ux`.

## Status
- One-screen complete-choice model shipped: Domain emits `ApprovalChoice`
  rows (exact/action recommended, exact/session, bounded/session; bounded/
  action never), the prompt returns only `choiceId`, the broker resolves it,
  and ActionLifecycle validates the option/lifetime pair against the
  request's choices.
- Bounded process matchers are executable + first-argv-token only; general
  executors (shells/interpreters/package managers/build drivers) get no
  bounded choice; bounded candidates ordered by authority containment,
  incomparable → omitted.
- Capability-derived authority summaries cover every family (mixed actions
  get one bullet per capability).
- Containment preflight (T032): `containment-preflight.ts` + policy denial
  before prompting when `environmentIsolation` is false for process actions;
  agent `getContainmentStatus()`; `/permissions status` shows backend + root.
- Local deadline 5 min default (T033); immediate settle on parent abort,
  request replacement, TUI unmount (FR-020) — two hook bugs found by
  subagent tests and fixed (resolverRef wiring, unmount pre-null guard).
- 979/979 tests (101 files), both strict tsc gates, release build — green.

## Not Done (honest record)
- T025 + T037–T040 (manual quickstart S1–S8, platform runs, 5-user pass,
  audit redaction check, go/no-go review): require a real provider session /
  human users; not executable in this environment. Automated equivalents
  cover every scenario.
- CodeRabbit review not run (signed out).

## Next Steps
- Run quickstart S1–S8 manually with a real provider on macOS + Linux;
- 5-person usability pass (S2/S5);
- then merge `011-tui-permission-scope-ux` to `main`.
