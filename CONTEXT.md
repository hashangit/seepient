# Context

**Current Task**: Spec 008 (permission-system-redesign) — COMPLETE.

## Status
- 66/66 tasks complete across P0-P6. 842/842 tests pass (+310 new); clean tsc.
- The spec's release gates are met at the contract/test layer.

## Key Artifacts
- docs/permissions-008.md — operator guide
- docs/security-review-008.md — independent reviewer package (threat model,
  asset map, call paths, audit checklist; the attestation itself is the
  reviewer's, per FR-020)
- docker-compose.008.yml — reference control-plane/scheduler/broker/db topology

## Production Handoff
The remaining items are OPERATIONAL, not implementation:
- Run the security review (docs/security-review-008.md) — human gate per FR-020.
- Substitute PostgreSQL/Redis for the in-memory stores in production.
- Ship the Rust seepient-fs-commit helper binary (separate build artifact).
- Wire real mTLS signing keys for dispatch signatures + broker lease tokens.
- Flip `permissionPipeline` default to true after adapter soak-in.
