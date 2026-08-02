# Context

**Task**: Spec 011 (tui-permission-scope-ux), branch `011-tui-permission-scope-ux`.

## Status
- Round-4 review fixes: persistent-grant WAL (durable outbox intent BEFORE
  the policy CAS — audit+outbox double failure denies with nothing
  installed), private scratch TMPDIR authoritative over ambient values,
  strict request binding (exact requestId/actionDigest, explicit lifetime),
  full vault reconciliation.
- 1016+ tests, strict tsc, build green (re-run before commit).

## Not Done
- T025/T037–T040: manual quickstart + Linux canaries + 5-user pass + audit
  redaction + go/no-go (need real sessions/platforms).

## Next
- Manual quickstart macOS + Linux (T025/T037); 5-user pass (T038); audit
  redaction review (T039); go/no-go (T040); then merge.
