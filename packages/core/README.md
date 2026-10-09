# seepient-core

Seepient's chat/agent engine as a slim, separately installable package: multi-turn chat, streaming, the provider system, and injectable store contracts — without the full agent's built-in tools, browser automation, sandbox, MCP gateway, or terminal UI.

**Clean-install closure: ~102 MB** (budget ≤ 150 MB) versus ~301 MB for the full [`seepient`](https://www.npmjs.com/package/seepient) package.

## Install

```sh
npm install seepient-core
```

## Chat-only quickstart

Providers are a record of provider entries keyed by account id. A provider's `credential` is a *reference* into a credential store you inject — the engine never accepts inline key material, and environment-variable references are refused by design. Put the key in a `MemoryCredentialStore` (or your own database-backed implementation of the same contract) and point the provider at it.

The examples are TypeScript — save them as `.ts` and run with `npx tsx`, or compile with your own toolchain.

```ts
import { createChat, MemoryCredentialStore } from 'seepient-core';

const credentials = new MemoryCredentialStore();
await credentials.put('openai-main', {
  kind: 'api_key',
  keyValue: process.env.OPENAI_API_KEY!, // your key, your store
});

const chat = await createChat({
  stateless: true,           // no session persistence — your app owns durability
  tenancy: 'single',         // solo deployment (multi-tenant: 'multi' + principalId + cwd)
  skills: false,             // no filesystem skill discovery in a slim function
  credentials,               // the store the engine resolves credential refs against
  providers: {
    'my-openai': {
      adapter: 'pi-ai',
      upstreamProvider: 'openai',
      credential: { kind: 'seepient', id: 'openai-main' },
    },
  },
  modelAssignments: {
    text: { standard: { providerAccount: 'my-openai', model: 'gpt-4.1-mini' } },
  },
  systemPrompt: 'You are a helpful assistant.',
});

// One turn, full result:
const turn = await chat.send('What is the capital of France?');
console.log(turn.text);

// One streaming turn. A failed turn throws from the loop (and fullText
// rejects) — vendor auth failures are never silent:
const stream = await chat.stream('Go on');
try {
  for await (const delta of stream.textStream) process.stdout.write(delta);
} catch (err) {
  console.error('turn failed:', err);
}

// The session owns its history across turns:
console.log(chat.messages.length);
```

Host-executed tools run in your own code and complete on the engine's light default pipeline:

```ts
import { createChat, trustedHostTool } from 'seepient-core';

const getBalance = trustedHostTool({
  definition: {
    type: 'function',
    function: {
      name: 'get_balance',
      description: 'Get the user account balance',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  execute: async () => JSON.stringify({ balance: 42 }),
});

const chat = await createChat({ stateless: true, tools: [getBalance] /* + providers */ });
const res = await chat.send('What is my balance?');
```

A construction that passes **no** provider-family option (`providers`, `modelAssignments`, `credentials`, `overlayFile`, `adapter`) composes the host's ambient provider configuration — `~/.seepient/providers-overlay.json` plus the ambient credential store, exactly like the full package's single-user operator path. On a machine where you use the `seepient` CLI, the snippet above would route through those accounts; on a clean image it fails typed with a "configure providers" message. To guarantee isolation, pass a provider record — even an empty one (`providers: {}`) — or your own stores.

Inject your own stores (sessions, audit, policy, capability ledger) for durability — the engine routes all consent/audit/tenancy machinery through them exactly as the full package does. The full-package guides ([`askSeepient`](https://github.com/hashangit/seepient/blob/main/docs/sdk/ask-seepient.md), [`createSeepient`](https://github.com/hashangit/seepient/blob/main/docs/sdk/create-seepient.md), [stateless workers](https://github.com/hashangit/seepient/blob/main/docs/sdk/stateless-workers.md)) apply to this package identically except where they touch built-in tools, the sandbox, or the MCP gateway.

## What is NOT here

The full [`seepient`](https://www.npmjs.com/package/seepient) package adds the built-in tool set (files, shell, browser, email, media generation), the OS sandbox and effect broker, the MCP gateway, and the CLI/TUI/server surfaces. From `seepient-core` those fail closed with typed, actionable errors naming `seepient` — never a mid-conversation module crash:

- Built-in tool names (e.g. `read_file`) are rejected at registration, naming `seepient`.
- Media/image generation without a registered vendor denies typed.
- Exact-BPE token counting degrades to a heuristic; `usage.estimateMode` reports `"heuristic"` (the full package reports `"exact"`).
- Provider model discovery is a full-package surface — the core entry exposes no `refreshModels`.

## Mixing with the full package

Registering the full `seepient` package anywhere in the same process (importing it, the server, or the CLI) flips the engine's defaults to the full-package composition for every agent in that process — including ones constructed through `seepient-core`. Keep serverless deployments single-package.

## Deep imports

`seepient-core/dist/...` is reserved for the full package's internal use — no stability promise. Import from the package root only.
