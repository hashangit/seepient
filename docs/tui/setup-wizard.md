---
title: Setup wizard
description: Configure providers, models, and credentials with the interactive setup wizard.
---

# Setup wizard

The setup wizard is an interactive terminal interface for configuring LLM providers, validating API keys, and setting default model routing.

Launch the wizard from your terminal:

```bash
seepient setup
```

<TermMenu
  title="Seepient Setup Wizard — Select an action:"
  :items="[
    'Add or configure an LLM provider',
    'Configure Purpose × Tier model routing',
    'Test provider connections',
    'Configure consent mode & sandbox',
    'Exit'
  ]"
  :selected="0"
/>

---

## 1. Provider configuration

When you select **Add or configure an LLM provider**, Seepient lists supported providers discovered from the upstream catalog:

- OpenAI
- Anthropic Claude
- Google Gemini
- Zhipu GLM
- DeepSeek
- OpenRouter
- Local endpoints (Ollama, vLLM, LM Studio)
- Custom OpenAI-compatible endpoints

### Credential storage modes

The wizard supports four ways to store and reference credentials:

1. **Environment variable reference (recommended)**: Links the provider to an existing environment variable name (for example, `ANTHROPIC_API_KEY`). Seepient resolves the secret from your environment at runtime, keeping credentials out of config files.
2. **Keychain storage**: On macOS and supported Linux desktops, Seepient encrypts the API key and writes it directly to your operating system keychain.
3. **Plaintext configuration**: Writes the API key to `~/.seepient/config.json` with `0600` permissions. Use this mode on headless servers without an OS keychain daemon.
4. **Keyless / local**: Configures local models (like Ollama on `http://127.0.0.1:11434`) that require no authentication tokens.

---

## 2. Live model catalog discovery

After authenticating with a provider, the wizard queries the provider's `/models` endpoint to discover available models in real time. 

For each model, Seepient displays:
- Context window size (for example, 200k tokens)
- Input, output, and cache token pricing
- Reasoning token support
- Vision and tool capability flags

---

## 3. Purpose × Tier assignment

The wizard guides you through assigning models to operational roles:

- **Text (Standard)**: The default companion model for general tasks.
- **Commit (Coding)**: The model responsible for analyzing code, formatting patches, and writing files.
- **Complex Reasoning**: The model invoked when a task requires deep planning or architectural decomposition.
- **Media**: The backend used when generating images or visual mockups.

---

## 4. Connection verification

Before saving changes to disk, the wizard sends a minimal test ping to each configured provider. If the request fails (due to an invalid API key, network timeout, or billing restriction), the wizard highlights the error details and prompts you to correct the credentials.

Settings are written atomically to `~/.seepient/config.json`. Existing comments, workspace-specific overrides, and unrelated settings are preserved.
