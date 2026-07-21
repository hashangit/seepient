# Context

**Current Task**: Implementing spec 008 (permission-system-redesign) from the Obsidian vault.

## Key Decisions
- P0–P3 core shipped: Foundations contracts, Domain policy pipeline (PolicyEngine, ActionLifecycle, PolicyStore, AuditRecorder), local execution boundary (commit broker, effect broker, model-egress gate), approval brokers. 649/649 tests pass (+117 new).
- Co-located tests in `src/**/__tests__/` (repo convention) rather than vault-spec `test/permissions/` path — vitest.config.ts only includes the former.
- P0/P1 ship behind opt-in `AgentLoopOptions.actionLifecycle` flag; legacy matrix/grant path untouched.

## Next Steps
- P3 remaining: wire analyzers into every built-in tool (T102/T103/T111/T205), `/permissions` command (T307), TUI rendering (T306).
- P4: server control/worker split (Docker scheduler, durable approvals).
- P5: governed self-evolution runtime (candidate workspaces, external activation client).
