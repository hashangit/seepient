# seepient-engine

`seepient-engine` is the chat engine from [Seepient](https://github.com/hashangit/seepient), packaged on its own. Multi-turn chat, streaming, tools that run in your own code, a provider system, and storage you inject. It does not ship the full agent's built-in tools, sandbox, browser, email, media generation, or terminal UI. A clean install is ~102 MB; the full [seepient](https://www.npmjs.com/package/seepient) package is ~301 MB.

Requires Node 22.19+.

## Install

```sh
npm install seepient-engine
```

## Quickstart

This is a complete program. It sends one turn, streams the next, and fails loudly on a bad key.

The examples use top-level `await`, so save them as `.mts` (or add `"type": "module"` to your package.json) and run with `npx tsx`.

```ts
import { createChat, MemoryCredentialStore } from 'seepient-engine';

const credentials = new MemoryCredentialStore();
await credentials.put('openai-main', {
  kind: 'api_key',
  keyValue: process.env.OPENAI_API_KEY!, // your key, your store
});

const chat = await createChat({
  stateless: true,           // no session persistence; your app owns durability
  tenancy: 'single',         // solo deployment. Multi-tenant: 'multi' + principalId + cwd
  skills: false,             // disable filesystem skill discovery
  credentials,               // the store the engine resolves credential references against
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

// One streaming turn. A failed turn throws from the iterator, so a vendor
// 401 never looks like an empty answer:
const stream = await chat.stream('Go on');
try {
  for await (const delta of stream.textStream) process.stdout.write(delta);
} catch (err) {
  console.error('turn failed:', err);
}

// The session owns its history across turns:
console.log(chat.messages.length);
```

About the credentials part, because it is the only ceremony in the example: the engine never accepts key material inline and never reads provider keys from environment variables. Keys live in a store you control (`MemoryCredentialStore` here, your database in production), and each provider account points at a key by id. That store-then-reference pattern is the whole grammar, and it is the same in the full package.

## The three front doors

**`createChat`** (above) is the smallest multi-turn shape. The session object owns the history; `chat.messages` is the conversation so far; `chat.stream()` gives you `textStream`, `fullText`, `finishReason`, and `usage`.

**`createSeepient`** is the longer-lived agent. Keep one instance per user or conversation, add a session id and a persistence store to survive restarts, and gate tool calls with your own consent check.

```ts
import { createSeepient } from 'seepient-engine';

const agent = await createSeepient({
  tenancy: 'single',
  // providers + credentials + modelAssignments: same shapes as the quickstart
  sessionId: 'user-42',
  persist: myStore, // save/load/delete/list; your database fits here
  approveTool: async () => true, // consent check for tools; return false to deny
});

const res = await agent.chat('Summarize the thread so far.');
const stream = await agent.chatStream('And stream the next one.');
```

**`askSeepient`** is the one-shot. One call in, one result out, no state kept. Pass `{ stream: true }` for streaming.

```ts
import { askSeepient } from 'seepient-engine';

const answer = await askSeepient('What is 2+2?', {
  tenancy: 'single',
  // providers + credentials + modelAssignments: same shapes as the quickstart
});
```

All three accept the same provider, credential, and store options, so moving between them is a constructor change, not a rewrite.

## Tools that run in your code

The engine ships no tools; you register your own. A trusted-host tool executes in your process, the model sees the result, and the turn continues.

```ts
import { createChat, trustedHostTool } from 'seepient-engine';

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

Tools that could do something sensitive get your `approveTool` callback before they run (see `createSeepient` above).

## Storage and tenancy

In single mode the engine defaults every store (audit, policy, capability ledger) to in-memory and writes nothing to disk. Pass `sessionId` plus a `persist` store to keep history, and inject your own audit, policy, or capability stores where you want durability.

For multi-tenant hosting you pass `tenancy: 'multi'` with a `principalId`, a `cwd`, your own stores, and an isolated provider runtime. That setup has real requirements; [stateless-workers.md](https://github.com/hashangit/seepient/blob/main/docs/sdk/stateless-workers.md) is the guide, not this page.

You can also inject skills: pass `sources` to load skill files from your own storage, or pass inline skill literals. See [skills.md](https://github.com/hashangit/seepient/blob/main/docs/sdk/skills.md).

## Where providers come from if you pass none

A construction with no `providers`, `modelAssignments`, `credentials`, `overlayFile`, or `adapter` uses the provider accounts already configured on the machine (`~/.seepient/providers-overlay.json`, plus its credential store). On a machine where you use the `seepient` CLI, your turns would route through those accounts and spend those keys. On a clean image you get a typed "configure providers" error instead. To pin a deployment down, pass a provider record, even an empty one (`providers: {}`).

## One wire limitation to know

Provider accounts with `upstreamProvider: 'openai'` or `'openai-compatible'` send chat turns to the OpenAI Responses API at `POST {baseUrl}/v1/responses`. Chat-completions-only servers, which is most Ollama and vLLM setups, do not work for chat yet. [providers.md](https://github.com/hashangit/seepient/blob/main/docs/sdk/providers.md) has the details.

## What is not in the box

The full [seepient](https://www.npmjs.com/package/seepient) package adds the built-in tools (files, shell, browser, email, media generation), the OS sandbox, the MCP gateway, and the CLI, TUI, and server. From `seepient-engine`, those refuse to load or run with a typed error that names `seepient`. Nothing crashes mid-conversation:

- Registering a built-in tool name like `read_file` is rejected at registration.
- Media and image generation without a registered vendor denies with a typed error.
- Token counting runs a character heuristic; `usage.estimateMode` reports `"heuristic"` where the full package reports `"exact"`.
- The agent objects expose no `refreshModels`; model discovery is a full-package feature.

## If the full seepient is also loaded

Importing the full `seepient` package anywhere in the same process (the library, the server, or the CLI) flips the engine's defaults for every agent in that process, including ones you built through `seepient-engine`. Keep serverless deployments single-package.

## No deep imports

`seepient-engine/dist/...` paths are reserved for the full package's internals and carry no stability promise. Import from the package root.

## Where to read more

- [Stateless workers and serverless installs](https://github.com/hashangit/seepient/blob/main/docs/sdk/stateless-workers.md)
- [`createSeepient` reference](https://github.com/hashangit/seepient/blob/main/docs/sdk/create-seepient.md)
- [`askSeepient` reference](https://github.com/hashangit/seepient/blob/main/docs/sdk/ask-seepient.md)
- [Providers and credentials](https://github.com/hashangit/seepient/blob/main/docs/sdk/providers.md)
- [Custom tools](https://github.com/hashangit/seepient/blob/main/docs/sdk/custom-tools.md)
