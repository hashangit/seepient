# Context

**Current Task**: Implementing spec 008 (permission-system-redesign) from the Obsidian vault.

## Key Decisions
- 62/66 tasks complete across P0-P6. 791/791 tests pass (+259 new); clean tsc.
- One Domain policy pipeline replaces matrix/grant/admit/autoConfirm.
- P0/P1 ship behind opt-in `permissionPipeline` flag; legacy path preserved.
- Co-located tests in `src/**/__tests__/` (vitest convention).

## Remaining Work (4 tasks — require external resources)
- T405/T409/T411: server deployment validation — requires running Docker Engine.
- T605: independent security review — human gate by definition.

## Next Steps
- Run T405/T409/T411 on a Docker-enabled host (docker-compose.008.yml).
- Commission T605 independent security review.
- Flip `permissionPipeline` default to true after adapter soak-in.
