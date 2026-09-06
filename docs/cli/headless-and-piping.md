---
title: Headless and piping
description: Stream data through standard Unix pipelines and run automated multi-instance swarms.
---

# Headless and piping

Seepient functions as a standard Unix command-line utility. It reads input from standard input (`stdin`), writes results to standard output (`stdout`), and prints errors and progress status to standard error (`stderr`).

---

## Piping data via stdin

You can pipe data directly from other command-line tools into Seepient:

### Reviewing git diffs
```bash
git diff main...feature-branch | seepient "Review this diff for missing test cases and edge cases"
```

### Analyzing logs
```bash
tail -n 200 /var/log/app.log | seepient "Identify unique error spikes and summarize probable causes"
```

### Parsing test failure outputs
```bash
pnpm test 2>&1 | seepient -y "Fix the broken unit tests identified in the test output"
```

When stdin is attached, Seepient combines the piped stream with your prompt argument before querying the language model.

---

## Continuous integration pipelines

Seepient integrates cleanly into CI runners (such as GitHub Actions, GitLab CI, or Jenkins).

Example GitHub Action step:

```yaml
- name: Run Seepient Code Audit
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    SEEPIENT_CONSENT_MODE: autonomous-trusted
  run: |
    seepient -y "Inspect modified files in this pull request and check compliance with project guidelines"
```

Because stdout and stderr are separated:
- Agent responses and generated summaries write to `stdout` (safe for piping to PR comments or build artifacts).
- Sandbox notifications, status spinners, and diagnostic logs write to `stderr`.

---

## Multi-instance swarm loops

Because Seepient maintains a lightweight memory footprint and low startup overhead, you can orchestrate multi-agent batch tasks using standard shell loops or `xargs`:

```bash
#!/usr/bin/env bash
# Run parallel security reviews across all microservice folders

for dir in services/*; do
  (
    cd "$dir" || exit 1
    echo "Auditing $dir..."
    seepient -y "Run a security audit on this service and write findings to SECURITY_REPORT.md"
  ) &
done

wait
echo "All audits completed."
```
