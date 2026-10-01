---
title: Process sandboxing
description: Host containment with macOS Seatbelt, Linux Bubblewrap, SSRF protection, and secret egress gates.
---

# Process sandboxing

When Seepient executes shell commands, it isolates the child process from the host operating system using kernel-enforced sandboxing.

---

## Operating system sandboxes

### macOS: Seatbelt (`sandbox-exec`)
On macOS, Seepient compiles a Scheme-based Seatbelt profile before spawning commands:
- **Filesystem containment**: The current project directory is mounted read-write. Common system library paths (`/usr`, `/System`, `/Library`, `/opt/homebrew`) are mounted strictly read-only.
- **Protected paths**: Sensitive user directories (such as `~/.ssh`, `~/.aws`, `~/.gnupg`, and browser profile folders) are blocked from both reading and writing.
- **Process isolation**: The sandboxed process cannot inspect or attach to other running host processes (`mach-lookup` restrictions).

### Linux: Bubblewrap (`bwrap`)
On Linux, Seepient wraps execution with Bubblewrap, leveraging unprivileged user namespaces:
- **Root filesystem**: The host filesystem (`/`, `/usr`, `/lib`, `/bin`) mounts read-only.
- **Isolated `/tmp` and `/home`**: A private tmpfs is provisioned for temporary files.
- **Workspace mount**: Only the designated workspace directory mounts read-write.
- **IPC isolation**: Sandboxed processes cannot see or communicate with host processes over System V IPC or POSIX shared memory.

---

## Secret shield and egress gate

Even inside an OS sandbox, an agent might attempt to curl an external server with sensitive tokens.

The **Egress Gate** inspects outgoing network requests and tool arguments:
1. **SSRF protection**: Rejects network requests targeting cloud metadata IP addresses (such as `169.254.169.254` for AWS/GCP instance credentials) and internal loopback addresses unless explicitly allowed.
2. **Credential redaction**: Automatically strips known provider API-key variables (and any variable whose name matches the provider-key patterns) from the sandbox environment, so their values cannot reach tool output or the model.
3. **Response caps** (022-5-WO2): Brokered network tool responses (e.g. `read_website`) abort mid-stream once the body exceeds 10 MiB or the request exceeds 30 s, matching the broker's own limits — a response is never buffered without bound in the host process.

## Process lifecycle: no daemons by default (022-5-WO1, D2)

Sandboxed command execution kills the whole process group when the command settles — on normal completion as well as on abort. A tool call that backgrounds children (`server & …`) does not leave them running after the call returns: the boundary treats a settled exec as finished work and reaps its descendants. This is intended product behavior on every path (contained and uncontained); pin it by test before changing it.

---

## Fail-closed isolation

If sandboxing is enabled but the host platform cannot provision the sandbox jail:
- Execution halts with an `ISOLATION_UNAVAILABLE` error.
- Seepient never quietly falls back to uncontained shell execution.
- To intentionally run without sandboxing (for example, in an already isolated throwaway Docker container), you must supply the explicit `--no-sandbox` flag.
