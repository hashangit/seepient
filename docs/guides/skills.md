---
title: Skills system
description: Reusable agent playbooks, AGENTS.md discovery, and dynamic skill injection.
---

# Skills system

Skills are self-contained folders that teach Seepient how to complete specific tasks. They package instructions, scripts, schemas, and reference material that load into the agent context on demand.

## Skill folder layout

A skill lives in a directory containing at minimum a `SKILL.md` file:

```text
skills/my-code-reviewer/
├── SKILL.md
├── references/
│   └── style-guide.md
└── scripts/
    └── check-syntax.sh
```

### The `SKILL.md` file

The main instruction file uses markdown with YAML frontmatter:

```markdown
---
name: code-reviewer
description: Review pull requests for architectural boundaries, test coverage, and security regressions.
---

# Code Reviewer Skill

When reviewing pull requests:
1. Verify that changes follow responsibility layers.
2. Confirm that tests accompany new logic.
3. Check for unhandled error cases.
```

## Where skills live

Seepient searches for skills in three locations:

1. **Workspace skills**: `.agents/skills/` or `skills/` within your current project root.
2. **User global skills**: `~/.seepient/skills/` available across all workspaces on your machine.
3. **Bundled skills**: Built-in skills packaged directly with Seepient.

## AGENTS.md standard

Seepient supports the `AGENTS.md` standard. When starting up, Seepient searches the repository hierarchy for `AGENTS.md` files:

- Project root `AGENTS.md`
- Subdirectory `AGENTS.md` files for package-specific rules in monorepos
- User global rules in `~/.seepient/AGENTS.md`

Rules found in these files are parsed and assembled into the agent system prompt using a four-layer trust hierarchy:
1. System runtime invariants (immutable security policies)
2. Global user rules
3. Repository-level project instructions
4. Turn-level user instructions

## Turn-scoped skill switching

Skills do not bloat the system prompt permanently. During execution:

1. Seepient registers only the names and descriptions of available skills in its initial context.
2. When the model decides it needs a skill (or when you invoke it with `/skill name`), Seepient loads the full `SKILL.md` content into that specific turn.
3. Once the task finishes, the heavy context unloads, keeping prompt token costs low and preventing unrelated instructions from polluting subsequent queries.

## Ephemeral injection and mandatory skills

You can declare mandatory skills in your configuration or command-line flags:

```bash
seepient --skill code-reviewer "Review the changes in src/domain"
```

Mandatory skills load before any user prompt executes and remain pinned throughout the task.
