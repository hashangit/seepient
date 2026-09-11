---
title: Local LLMs with Ollama
description: Run offline agents with local models and automatic cloud fallback.
---

# Local LLMs with Ollama

This recipe configures Seepient to run tasks using a local Ollama instance, falling back to a cloud model if the local service is offline or overloaded.

---

## 1. Start Ollama with your chosen models

Pull your preferred coding and general instruction models:

```bash
ollama pull qwen2.5-coder:14b
ollama pull llama3.3
```

Confirm Ollama is serving on `http://127.0.0.1:11434`.

---

## 2. Configure Seepient

You can configure Seepient to use your local Ollama instance in two ways:

### Option A: Environment variables (Recommended)

Set the OpenAI-compatible base URL in your shell environment or `.env`:

```bash
export OPENAI_COMPAT_BASE_URL="http://127.0.0.1:11434/v1"
export OPENAI_COMPAT_API_KEY="ollama"
```

### Option B: Interactive setup or CLI

Run the interactive setup wizard to configure the provider and choose default models:

```bash
seepient setup
```

Or configure via the CLI:

```bash
seepient providers add local-ollama \
  --adapter pi-ai \
  --upstream openai-compatible \
  --base-url http://127.0.0.1:11434/v1
```

---

## 3. Verify execution and fallback

Run a test prompt:

```bash
seepient "Explain how async generators work in TypeScript"
```

Seepient routes the prompt to `local-ollama` using `llama3.3`. 

If you stop the Ollama server (`pkill ollama`) and rerun the prompt, Seepient detects the connection failure, logs a fallback notification to stderr, and completes the request using `claude-3-7-sonnet`.
