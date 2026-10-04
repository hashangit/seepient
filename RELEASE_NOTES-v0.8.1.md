# Seepient 0.8.1

Patch release: one engine fix, no new features, no breaking changes.

## Fixed

**Loop errors now surface through the middleware pipeline.** Seepient's agent loop reports failures two ways: it throws, or it returns a result with `finishReason: "error"` and an `error` object. The middleware wrapper (`PipelineContext`) propagated the throw path correctly but dropped the `error` field on the return path, so SDK consumers could not tell an error result from a success-shaped one.

Concretely, with any middleware in the chain (auth, rate-limit, logging, or custom):

- `onError` never fired for return-style loop failures such as `EMPTY_COMPLETION` (a model finishing its turn with no text and no tool calls) or provider stream errors.
- `chatStream`/`askSeepient({ stream: true })` resolved `fullText` normally instead of rejecting, and delivered an empty answer with no error signal.
- Non-streaming `chat`/`askSeepient` returned empty text instead of throwing the typed `SeepientError`.
- On the standalone server's WS/SSE chat, a tenant client received no terminal frame at all for such failures — the connection went silent after the ack. It now receives a typed error frame (`code`, `retryable`).

Callers running the bare loop (no middleware) were never affected.

## What does not change

- REST response bodies stay generic by design (`PROVIDER_ERROR` / `Generation failed`); the typed message reaches the SDK embedder's `onError` or exception and the operator's server-side log, not the wire.
- Error message text on the wire is unchanged and remains generic; nothing new is exposed to tenants.

## Upgrade notes

- Pull and rebuild. No configuration, credential, or tenant changes are needed, and no client-facing wire contract is removed — the WS change is additive (a frame where there was silence).
- The pipeline now passes the loop result through unchanged (`PipelineContext.result` gained an optional `error` field, same shape as the loop's error object). Middleware that inspects `ctx.result` sees one extra field.

## Verification

Regression pins cover both halves, each proven to fail on the unfixed tree: the domain-level copy (`EMPTY_COMPLETION` through a passthrough middleware keeps the loop error) and the end-to-end SDK path (`chatStream` with creation-level middleware fires `onError` with the typed provider error). Full suite, mutation probes, examples, and build green at the release commit; the release-gate receipt is recorded in the project's internal review vault.
