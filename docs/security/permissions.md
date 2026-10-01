---
title: Permissions and consent
description: The PolicyEngine, consent modes, and durable file-locked approvals in Seepient.
---

# Permissions and consent

The permission system governs when Seepient asks for human confirmation and how long authorizations remain valid.

---

## Consent modes

Seepient defines three consent modes:

### 1. `ask-everything`
Every action that causes external side effects requires explicit user confirmation.
- Read-only operations (`read_file`, `web_search`, `get_current_datetime`) run automatically.
- Shell commands (`execute_shell_command`), file writes (`write_file`, `edit_file`), emails, and notifications require approval.
- Recommended for sensitive environments where full human oversight is needed.

### 2. `edit-enabled` (default)
Permits routine workspace edits, reads, and normal development tools within the project root while prompting for external or high-risk actions.
- Standard file reads, writes, edits, and workspace commands run without prompts.
- Destructive operations, network requests outside the boundary, and modifications outside the workspace root prompt for confirmation.
- Recommended for daily interactive development and local coding sessions.

### 3. `autonomous`
Permits all actions within the workspace boundary without prompting.
- Unattended CI/CD runners, container swarms, and batch automation scripts run in this mode.
- Safe operations are contained by the operating system sandbox (macOS Seatbelt or Linux Bubblewrap).
- If the agent attempts to access paths outside the sandbox or alter security policies, the sandbox kernel interface blocks the operation and logs the violation.

---

## Capability scopes and lifetimes

When you approve an action, you choose both its **scope** and **lifetime**:

### Scopes
- **Target-exact**: Grants authorization only for the exact file path or exact shell command string requested.
- **Directory**: Grants authorization for paths within a designated subfolder (for example, `src/components/*`).
- **Workspace**: Grants authorization across the entire current project directory.

### Lifetimes
- **One-shot**: Valid only for the immediate tool execution. Once executed, the capability expires.
- **Turn-scoped**: Valid for subsequent tool calls within the current conversational turn.
- **Session-scoped**: Valid for the remainder of the active session. Expires when Seepient exits.
- **Persistent grant**: Written to the workspace policy store (`~/.seepient/security/policies/<workspaceId>.json`), remaining active across sessions.

---

## Durable policy store

Policy grants and approval records are stored in a file-locked, tamper-evident store on disk (`~/.seepient/security/policies/<workspaceId>.json`, or `$SEEPIENT_SECURITY_DIR/policies/`).

Because policy records are written using atomic fsync operations:
- If the terminal crashes, power drops, or the server restarts while an approval is pending, the policy state survives.
- Multi-client architectures (such as the TUI and a web client connected to the same server) observe a consistent approval state without race conditions.
