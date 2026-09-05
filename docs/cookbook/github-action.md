---
title: GitHub Action PR reviewer
description: Automate pull request reviews and exact-commit code suggestions in CI pipelines.
---

# GitHub Action PR reviewer

This recipe demonstrates how to deploy Seepient inside a GitHub Actions workflow to review pull requests, check test coverage, and comment directly on the PR.

---

## Workflow configuration

Create `.github/workflows/seepient-review.yml`:

```yaml
name: Seepient PR Review

on:
  pull_request:
    types: [opened, synchronize]

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write

    steps:
      - name: Check out code
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22.19'

      - name: Install Bubblewrap and Seepient
        run: |
          sudo apt-get update && sudo apt-get install -y bubblewrap
          npm install -g seepient

      - name: Run Seepient Review
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          SEEPIENT_CONSENT_MODE: autonomous-trusted
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          # Extract the pull request diff
          git diff origin/${{ github.base_ref }}...HEAD > pr_diff.txt

          # Run Seepient in headless non-interactive mode
          cat pr_diff.txt | seepient -y \
            "Review this pull request diff for: \
             1. Architectural layer violations \
             2. Missing edge-case test coverage \
             3. Potential security regressions. \
             Provide a concise markdown report." > review_summary.md

          # Post the summary as a PR comment
          gh pr comment ${{ github.event.pull_request.number }} \
            --body-file review_summary.md
```

---

## Key security considerations

- **Bubblewrap isolation**: The workflow installs `bubblewrap` so the agent executes inside a locked-down Linux user namespace.
- **`SEEPIENT_CONSENT_MODE=autonomous-trusted`**: Authorizes file reads and inspections without waiting for interactive input.
- **Read-only checkout**: The GitHub Actions token receives write permission only for pull-request comments (`pull-requests: write`), preventing the agent from pushing commits to protected branches without human review.
