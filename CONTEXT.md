# Context

**Task**: Spec 011 (tui-permission-scope-ux), branch `011-tui-permission-scope-ux`.

## Status
- Round-2 review fixes: denyWrite protected stores (incl. SEEPIENT_SECURITY_DIR
  — found + fixed a real write-denial gap), durable pre-CAS audit with actor
  and policy versions, exact-argv coverage (argvExact), immediate revocation,
  uncontained opt-in semantics (environmentIsolation honest), timeout clamp +
  restart-required, fail-closed policy reads, pipeline-init error surfaced.
  Canaries: real macOS negative tests incl. disposable-HOME ancestor-write.
- 1000+ tests, strict tsc, build green (full re-run before commit).

## Not Done
- T025/T037–T040: manual quickstart + platform runs + 5-user pass + audit
  redaction + go/no-go (need real sessions). Linux canaries unexecuted here.

## Next
- Full suite + commit; manual quickstart macOS + Linux; merge.
