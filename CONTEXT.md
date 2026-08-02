# Context

**Task**: Spec 011 (tui-permission-scope-ux), branch `011-tui-permission-scope-ux`.

## Status
- Review fixes on the ASRT adapter (commit 7af5989): deny-by-default reads
  (`denyRead ["/"]`, system deps, protected paths — live-verified), typed
  spawn errors, cancelled-on-abort, process-tree kill, SEEPIENT_UNCONTAINED
  consistency, env-key validation, SDK types, host-callbacks at composition
  root. macOS negative canaries pass.
- Persistent project/global choices (exact-only, PolicyStore.compareAndSet),
  global store + /permissions status + revoke-global, 10-min configurable
  timeout, /permissions session-authority view.
- Gates: 982+ tests, strict tsc, build green (full re-run before commit).

## Not Done
- T025/T037–T040: manual quickstart + platform runs + 5-user pass + audit
  redaction + go/no-go (need real sessions). Linux canaries unexecuted here.

## Next
- Full suite + commit; manual quickstart macOS + Linux; merge.
