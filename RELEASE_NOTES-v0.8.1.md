# Seepient 0.8.1

Patch release: one engine fix, no new features, no breaking changes.

## Fixed

**Loop errors now surface through the middleware pipeline.** Seepient's agent loop reports failures two ways: it throws, or it returns a result with `finishReason: "error"` and an `error` object. The middleware wrapper (`PipelineContext`) propagated the throw path correctly but dropped the `error` field on the return path, so SDK consumers could not tell an error result from a success-shaped one.

Concretely, with any middleware in the chain (auth, rate-limit, logging, or custom):

- `onError` never fired for return-style loop failures such as `EMPTY_COMPLETION` (a model finishing its turn with no text and no tool calls) or provider stream errors.
- `chatStream`/`askSeepient({ stream: true })` resolved `fullText` normally instead of rejecting, and delivered an empty answer with no error signal.
- Non-streaming `chat`/`askSeepient` returned empty text instead of throwing the typed `SeepientError`.
- REST/WS error responses fell back to the constant `loop resolved with finishReason error` instead of the real message.

Callers running the bare loop (no middleware) were never affected.

## Upgrade notes

- Pull and rebuild. No configuration, credential, or tenant changes are needed.
- The pipeline now passes the loop result through unchanged (`PipelineContext.result` gained an optional `error` field, same shape as `AgentLoopError`). Middleware that inspects `ctx.result` sees one extra field.
- REST/WS error responses now carry the real typed loop message where they previously carried the constant fallback. If you match on the old constant string, match on the error `code` instead.

## Verification

Regression pins cover both halves: the domain-level copy (`EMPTY_COMPLETION` through a passthrough middleware keeps `result.error`) and the end-to-end consumer path (`chatStream` with passthrough middleware fires `onError` with the typed provider error). Full suite, mutation probes, examples, and build green at the release commit; release-gate receipt in the vault (`Reviews/2026-10-05-v0.8.1-release-gate.md`).
