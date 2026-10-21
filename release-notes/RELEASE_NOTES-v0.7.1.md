# Seepient 0.7.1

This patch release fixes the rough edges that escaped into 0.7.0. Most of the work came out of three review passes over the 021-4 remediation, and the short version is simple: a failed turn no longer kills your chat session, streaming errors are impossible to miss, and the network layer closes the last gap where a request could reach an address nobody validated.

## Sessions survive failed turns

The headline fix. When a turn ran a tool and the next model call failed (rate limit, timeout, network drop), 0.7.0 saved the conversation in a way that orphaned the tool result. Every provider rejects a tool result without its matching tool call, so that session was dead on the next message. Forever. The fix keeps the tool call and its result together, and a regression test now drives that exact scenario.

Failed turns also stopped corrupting history in a second way. A turn that dies mid-generation leaves its prompt stored for crash recovery. Your next message now resolves that draft in the store itself: an identical retry collapses to one copy, and a new question supersedes the old one. What the model sees, what the REST API returns, and what sits on disk finally agree.

## Streaming fails loudly

In 0.7.0, a streaming call that hit a provider error completed quietly with empty text unless you had attached an `onError` callback. Now `fullText` rejects with the typed error, matching the non-streaming behavior. If you only iterate `textStream`, nothing changes; the delta stream still closes cleanly.

Two type fixes ride along. `finishReason` no longer advertises a `"length"` value nothing ever produced, and it now includes `"aborted"`, which it always could return.

## Network defenses close their last windows

The effect broker resolved a domain, checked the addresses, then handed the request to an adapter that resolved the domain again. A hostile site flipping DNS between those two lookups could land the request, headers and all, on an internal address. The broker now passes its validated addresses to the adapter, which connects only to those. The gateway REST tool also refuses to follow a model-chosen absolute path off its registered origin, so a target's credentials can't be shipped to a host the model picked. Notification webhooks go through the same validated fetch path as everything else, and cross-origin redirects now keep only a small allowlist of headers, so credentials injected under custom header names can't leak on a redirect.

## Smaller fixes you'd still feel

* `agent.abort()` now stops image and media fetches in `createSeepient`, not just in `askSeepient`.
* `server.close()` removes the signal handlers an embedded server registered, so a host application's own Ctrl+C handling works again. `dispose()` also closes the server now.
* A dead WebSocket peer releases its connection slot within 30 seconds instead of holding it until TCP gives up.
* Oversized request bodies return `413` on every route, and the configured body-size limit applies to settings and gateway routes too.
* Long-lived `AbortSignal`s no longer collect one listener per `askSeepient` call.
* On an aborted or max-steps turn with no output, the server no longer returns (and stores) your previous turn's answer as the new one.
* The deprecated messages-only `SessionStore` is gone. It could save sessions it could never resume. Use `PersistenceBackend`; the CHANGELOG has the details.
* `pnpm build` cleans stale output from `dist/`, so a deleted module can't ship in the tarball.

## Docs and gates

The server docs now tell the truth about CORS (off unless you allowlist origins), the new environment variables, the chat `sessionId` field, `GET /v1/sessions`, and the WebSocket error codes clients actually receive. A real-socket test covers the WebSocket scope model, and SSE tool events report their real outcome instead of a hardcoded success.

## Upgrading

If you used the deprecated `SessionStore` interface, move to `PersistenceBackend`: save takes `(id, SessionData)` instead of `(id, Message[])`, and the object carries a `__persistenceBackend` marker. If you read `finishReason` as a union type, drop `"length"` and add `"aborted"`. Streaming callers who checked `finishReason === "error"` on a resolved `fullText` should switch to handling the rejection.
