---
title: Model routing
description: Purpose and tier model routing, catalog discovery, and fallback resilience in Seepient.
---

# Model routing

Seepient routes model requests through a two-dimensional matrix: **Purpose × Tier**. This decouples high-level agent tasks from specific model names and upstream vendors.

Instead of hardcoding a specific model identifier across your scripts, you assign models based on what the agent is doing and how much reasoning depth is required.

## The Purpose × Tier matrix

### Purposes

- **`text`**: General conversational queries, summaries, instruction following, and tool orchestration.
- **`commit`**: Code generation, exact patch production, diff calculation, and refactoring.
- **`plan`**: Multi-step project planning, task decomposition, and architectural design.
- **`vision`**: Image inspection, screenshot analysis, and visual question answering.
- **`media`**: Image generation via diffusion backends (Fal, Google Imagen, OpenAI DALL-E).

### Tiers

- **`standard`**: Balanced model used for daily tasks (for example, Claude 3.7 Sonnet, GPT-4o).
- **`complex`**: High-reasoning model invoked for difficult coding problems, architectural reviews, and deep planning (for example, o3-mini with high reasoning effort, Claude 3.7 with extended thinking).
- **`efficient`**: Low-latency, cost-effective model used for quick classifications, simple tool formatting, and log parsing (for example, GPT-4o-mini, Claude 3.5 Haiku, Gemini 2.5 Flash).

## Dynamic catalog discovery

Seepient does not rely on static model lists that become outdated when vendors release new checkpoints. 

During startup and via the `seepient setup` command, Seepient polls upstream provider catalogs. It resolves model IDs, context window limits, token pricing, reasoning token support, and modality capabilities automatically.

## Fallback traversal and circuit breakers

Network drops, rate limits (HTTP 429), and vendor service interruptions can halt automated pipelines. Seepient provides ordered fallback chains.

When configuring a purpose, you can supply primary and backup targets:

```json
{
  "routing": {
    "text": {
      "standard": {
        "provider": "anthropic",
        "model": "claude-3-7-sonnet",
        "fallbacks": [
          { "provider": "openai", "model": "gpt-4o" },
          { "provider": "local", "model": "deepseek-r1" }
        ]
      }
    }
  }
}
```

### Fallback rules

1. If the primary target fails with a transient error (such as a 5xx server error, timeout, or rate limit), the router transitions to the next fallback target.
2. A circuit breaker tracks failures per `(provider, model)`. When a model trips its error threshold, it enters a temporary cooldown period, allowing subsequent requests to bypass it immediately without waiting for a timeout.
3. Once a streaming response yields its first token to the user interface, no fallback replay occurs. This prevents confusing half-stream duplicates from displaying in the terminal.

## Token and cost accounting

Seepient tracks token metrics across four categories:

- **Input tokens**: Prompt and instruction tokens sent to the API.
- **Cached prompt tokens**: Input tokens served from provider prompt caches, discounted according to vendor pricing tables.
- **Output tokens**: Generated completion tokens.
- **Reasoning tokens**: Thinking tokens emitted during model deliberation.

At the end of each session or batch run, Seepient calculates total expenditure based on dynamic catalog rates and outputs the summary to the terminal or session history.
