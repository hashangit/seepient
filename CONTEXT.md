# Context

**Current Task**: Spec 011 (tui-permission-scope-ux) — implemented, three
review rounds fixed, on branch `011-tui-permission-scope-ux`.

## Status
- 24/25 tasks complete. T025 (quickstart manual scenarios S1–S5) is PENDING:
  it requires a human-driven interactive TUI session with a real provider.
- 969/969 tests (100 files), both strict typechecks, release build — green.
- Product acceptance (round 3) implemented:
  - Consent-style copy: "Only this command" / "Other commands using this
    program" / "Only this file" / "Other files in this folder"; durations
    "Just this time" / "Until I close Seepient". No [exact]/[bounded] tags,
    no "exact arguments", no raw executable paths in labels.
  - Two-step consent: nothing preselected; least-privilege pair marked
    "Recommended"; Enter on Scope commits + advances; Enter on Duration
    submits only after BOTH are committed.
  - Scope tab guaranteed at most two options (exact + ONE bounded).
  - Expiry messages no longer say "User denied"; typed reasons map to
    matching copy.
  - Spec/contracts/plan/research/data-model updated to match.
- Earlier review fixes still in place: frozen broker request clone + trusted
  snapshot (P0), revocation bound to lifecycle session, WS record/execution
  consistency with a representable legacy option, pre-abort denial, deadline
  race, no-strip action cleanup.

## Not Done (honest record)
- T025: interactive quickstart S1–S5 not executed (needs a terminal + real
  provider). Every behavior has an automated equivalent test.
- Manual feedback note: manual write tests must target the workspace
  (e.g. seepient-test-env/fixtures/), not /tmp — /tmp paths are outside the
  workspace root by design.

## Next Steps
- Run quickstart S1–S5 manually; mark T025 complete; then merge.
