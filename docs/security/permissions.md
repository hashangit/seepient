---
title: Permissions and consent
description: The PolicyEngine, consent modes, and durable file-locked approvals in Seepient.
---

# Permissions and consent

The permission system governs when Seepient asks for human confirmation and how long authorizations remain valid.

---

## Consent modes

Seepient defines three consent modes:

### 1. `always-ask` (default)
Every action that causes external side effects requires explicit user confirmation.
- Read-only operations (`read_file`, `web_search`, `get_current_datetime`) run automatically.
- Shell commands (`execute_shell_command`), file writes (`write_file`, `edit_file`), emails, and notifications require approval.
- Recommended for daily interactive development and sensitive environments.

### 2. `ask-untrusted`
Permits routine, low-risk tools within the project root while prompting for external or unusual commands.
- Standard build commands (such as `pnpm test` or `git status`) run automatically if matched by configured rule templates.
- Unrecognized binaries, network requests, and modifications outside the workspace root prompt for confirmation.
- Recommended for experienced developers wanting reduced prompts during local coding sessions.

### 3. `autonomous-trusted`
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
- **Persistent grant**: Written to workspace configuration (`.seepient/config.json`), remaining active across sessions.

---

## Durable approval store

Approval states are stored in a file-locked store on disk (`~/.seepient/approvals.json`).

Because approvals are written using atomic fsync operations:
- If the terminal crashes, power drops, or the server restarts while an approval is pending, the pending request survives.
- Multi-client architectures (such as the TUI and a web client connected to the same server) observe a consistent approval state without race conditions.
