---
title: Audit trail
description: Tamper-evident, append-only 0600 audit logging in Seepient.
---

# Audit trail

Every action prepared, approved, executed, or rejected by Seepient is recorded in an append-only audit ledger.

---

## Log location and file permissions

The audit log is stored at:

```text
~/.seepient/audit.log
```

The file is initialized with strict POSIX `0600` permissions (read and write access granted exclusively to the file owner; group and others have zero permissions).

---

## Record structure

The audit log uses newline-delimited JSON (NDJSON). Each record contains a complete trace of the action:

```json
{
  "timestamp": "2026-09-06T02:30:00.123Z",
  "eventId": "evt_01HXYZ987",
  "sessionId": "sess_20260905_a1b2",
  "surface": "tui",
  "model": {
    "provider": "anthropic",
    "model": "claude-3-7-sonnet",
    "purpose": "commit",
    "tier": "standard"
  },
  "action": {
    "tool": "edit_file",
    "target": "src/domain/agent-loop.ts",
    "preImageHash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "lineRange": [42, 49]
  },
  "approval": {
    "decision": "approved",
    "mode": "always-ask",
    "decidedBy": "human_interactive"
  },
  "outcome": {
    "status": "success",
    "exitCode": 0,
    "executionTimeMs": 42
  }
}
```

---

## Fsync durability

When an action executes, Seepient writes the audit record and issues a synchronous `fsync` syscall to flush buffer caches to physical storage before reporting success to the user interface.

If the machine loses power immediately following a file write, the audit record documenting the modification is guaranteed to be on disk.

---

## Inspecting the audit log

Use the CLI to query and inspect audit records:

```bash
# View recent events
seepient audit --limit 10

# Filter by a specific session
seepient audit --session sess_20260905_a1b2

# Stream live audit records
tail -f ~/.seepient/audit.log | jq .
```
