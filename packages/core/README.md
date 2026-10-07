# seepient-core

Seepient's chat/agent engine as a slim, separately installable package: multi-turn chat, streaming, the provider system, and injectable store contracts — without the full agent's built-in tools, browser automation, sandbox, MCP gateway, or terminal UI.

**Clean-install closure: ~102 MB** (budget ≤ 150 MB) versus ~301 MB for the full [`seepient`](https://www.npmjs.com/package/seepient) package.

## Install

```sh
npm install seepient-core
```

## Chat-only quickstart

Providers are a record of provider entries keyed by account id; credentials reference where the key lives (`env`, `seepient`, `keychain`, `externalsecret`, or `none`) — the engine never accepts inline key material:

```ts
import { createChat } from 'seepient-core';

const chat = await createChat({
  stateless: true,           // no session persistence — your app owns durability
  tenancy: 'single',         // solo deployment (multi-tenant: 'multi' + principalId + cwd)
  skills: false,             // no filesystem skill discovery in a slim function
  providers: {
    'my-openai': {
      adapter: 'pi-ai',
      upstreamProvider: 'openai',
      credential: { kind: 'env', name: 'OPENAI_API_KEY' },
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

// One streaming turn:
const stream = await chat.stream('Go on');
for await (const delta of stream.textStream) process.stdout.write(delta);

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

Inject your own stores (sessions, audit, policy, capability ledger) for durability — the engine routes all consent/audit/tenancy machinery through them exactly as the full package does.

## What is NOT here

The full [`seepient`](https://www.npmjs.com/package/seepient) package adds the built-in tool set (files, shell, browser, email, media generation), the OS sandbox and effect broker, the MCP gateway, and the CLI/TUI/server surfaces. From `seepient-core` those fail closed with typed, actionable errors naming `seepient` — never a mid-conversation module crash:

- Built-in tool names (e.g. `read_file`) are rejected at registration, naming `seepient`.
- Media/image generation without a registered vendor denies typed.
- Exact-BPE token counting degrades to a heuristic; `usage.estimateMode` reports `"heuristic"` (the full package reports `"exact"`).
- Provider model discovery (`refreshModels`) degrades with an actionable message.

## Deep imports

`seepient-core/dist/...` is reserved for the full package's internal use — no stability promise. Import from the package root only.
