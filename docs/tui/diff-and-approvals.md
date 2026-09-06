---
title: Diffs and approvals
description: Interactive file diff reviews, permission escalation dialogs, and atomic approval handling in the TUI.
---

# Diffs and approvals

When language models attempt to modify source files or execute host commands, the TUI intercepts the action before execution. It displays an interactive confirmation dialog with unified diff previews and scope controls.

---

## 1. The inline diff viewer

When a model calls `edit_file` or `write_file`, the TUI presents a color-coded diff:

<TermDiff
  title="Proposed Changes: src/domain/agent-loop.ts"
  :lines="[
    ' @@ -42,7 +42,8 @@',
    '   const model = this.router.resolve(purpose, tier);',
    '-  const stream = await model.generate(prompt);',
    '+  const stream = await model.generate(prompt, {',
    '+    signal: abortController.signal',
    '+  });',
    '   return this.processStream(stream);'
  ]"
  :meta="[
    'Target: src/domain/agent-loop.ts (lines 42-49)',
    'Pre-image hash: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  ]"
/>

### Navigating long diffs
For multi-line refactors that exceed the terminal viewport:
- Press `d` to expand the diff into full-screen scroll mode.
- Use `Up` and `Down` or `PageUp` and `PageDown` to inspect changes across all modified blocks.
- Press `Esc` or `q` to return to the approval dialog.

---

## 2. Approval decisions

The approval dialog provides four primary actions:

| Key | Decision | Effect |
|---|---|---|
| `Enter` / `y` | **Approve once** | Executes this specific prepared action draft. |
| `a` | **Approve for session** | Grants authorization for identical actions for the remainder of this session. |
| `r` | **Reject with feedback** | Aborts execution. Opens a short text prompt where you can explain why the change was rejected. |
| `Esc` / `n` | **Reject silently** | Aborts execution and notifies the model that the action was refused. |

When you reject a change with feedback, your explanation returns to the model as tool output. The model uses this feedback to correct its approach and propose an alternative.

---

## 3. Scope and duration controls

For actions that access filesystem paths or network resources, the TUI provides multi-tab duration and scope controls:

- **Target scope**: Limit authorization to the single requested file path, the parent directory, or the whole workspace.
- **Duration**: Restrict approval to the current turn, the current session, or persist as a saved rule in workspace configuration.

All approved actions are committed to the append-only `~/.seepient/audit.log` along with the timestamp, target resource, and approval decision.
