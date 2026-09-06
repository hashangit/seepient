---
title: Execution lifecycle
description: The step-by-step path of an action from user prompt to sandboxed execution and audit logging.
---

# Execution lifecycle

Every request processed by Seepient moves through an eight-step pipeline. This lifecycle guarantees that language models never execute unchecked operations on the host system.

<DiagramFlow numbered
  :steps="[
    { title: 'Surface ingestion' },
    { title: 'Context assembly & skill resolution' },
    { title: 'Model routing & streaming inference' },
    { title: 'Tool call interception & PreparedActionDraft creation' },
    { title: 'Policy evaluation & consent check' },
    { title: 'Approval broker' },
    { title: 'Sandboxed execution & exact file commit' },
    { title: 'Output delivery & tamper-evident audit commit' }
  ]"
/>

---

## Step 1: Surface ingestion

A prompt enters through one of the supported interfaces:
- An interactive prompt in the full-screen terminal UI.
- A command argument or stdin pipe in the CLI.
- An HTTP `POST /v1/sessions/:id/messages` call or incoming WebSocket payload.
- A programmatic call to `agent.chat(prompt)` in the TypeScript SDK.

The surface validates the payload, checks authentication if running over HTTP/WS, and attaches or creates a session context.

## Step 2: Context assembly and skill resolution

Before querying an upstream model, Seepient prepares the turn context:
1. **Rule discovery**: Loads active project instructions from `AGENTS.md` and user settings.
2. **Skill injection**: Identifies matching skills from `.agents/skills/` or user-specified flags, injecting the relevant `SKILL.md` instructions into the system prompt.
3. **Session history**: Pulls prior turn messages, pruning or summarizing older messages if context limits approach the model window.
4. **Environment context**: Detects container status, working directory path, and current system timestamp.

## Step 3: Model routing and streaming inference

The router evaluates the task purpose (`text`, `commit`, `plan`, `vision`, `media`) and requested tier (`standard`, `complex`, `efficient`):
1. Selects the primary model endpoint and checks circuit breaker status.
2. Initiates a streaming connection to the upstream provider.
3. Parses streaming tokens in real time, routing text fragments to the active surface for live display.
4. If a transient network failure occurs before tokens stream to the user, the router switches to the configured fallback target.

## Step 4: Tool call interception and action preparation

When the model emits a structured tool call (such as editing a file or running a bash command):
1. Seepient pauses model generation.
2. The capability tool parses the arguments and generates a `PreparedActionDraft`.
3. For file mutations, the tool computes pre-image hashes of the existing file on disk and formats the proposed diff.
4. For shell commands, the tool parses the command line, extracts target binaries, and flags required system capabilities (such as network access or write permissions).

## Step 5: Policy evaluation and consent check

The permission engine evaluates the `PreparedActionDraft` against three boundaries:
1. **Active consent mode**: `always-ask`, `ask-untrusted`, or `autonomous-trusted`.
2. **Path restrictions**: Ensures file modifications target paths inside the allowed workspace root, rejecting attempts to access sensitive directories like `/etc` or `~/.ssh`.
3. **Self-evolution rules**: Rejects attempts by the model to modify Seepient's own security boundaries, permission stores, or audit configurations without explicit out-of-band authority.

If the action is read-only or fully permitted by the active policy, it proceeds directly to Step 7.

## Step 6: Approval broker

If the action requires confirmation:
- In the **TUI**, a modal prompt appears displaying the proposed command or a color-coded split diff of the file change. The user can approve once, approve for the remainder of the session, or reject with feedback.
- In the **CLI**, if `-y` was supplied, the action proceeds automatically. Otherwise, an interactive confirmation prompt appears on stderr.
- Over **WebSocket / HTTP**, a `permission_request` event streams to the client, which returns an approval or rejection message.

If rejected, the rejection and any user-provided explanation are returned to the model as tool output, allowing the model to propose an alternative solution.

## Step 7: Sandboxed execution and exact file commit

Once approved, execution begins:

### Shell execution
The command runs inside an operating system sandbox:
- macOS: `sandbox-exec` with a restrictive Seatbelt profile.
- Linux: `bwrap` (Bubblewrap) mounting the host root read-only, with write access limited to the workspace directory.

### File mutations
The change passes to the native `seepient-fs-commit` Rust helper. The helper performs three checks:
1. Compares the current file hash against the pre-image hash recorded during preparation.
2. Locates the exact search block targeted for replacement.
3. Writes the updated content using atomic temporary files and filesystem renames.

If the file on disk was modified by an external process between preparation and execution, the commit aborts immediately without altering the file.

## Step 8: Output delivery and audit recording

After the action completes:
1. Execution stdout, stderr, and exit status return to the model as the result of the tool call.
2. The model continues its reasoning loop, either generating final text or planning the next tool step.
3. The audit recorder writes the full event record (timestamp, surface, model, prepared action, approval state, and execution outcome) to `~/.seepient/audit.log` using atomic fsync commits.
