# Seepient 0.8.2

Patch release: dependency currency plus one contained port. No new features, no breaking changes, no public surface change.

## Changed

**The inference library (`@earendil-works/pi-ai`) is current at 1.0.2**, upgraded from 0.87.1. This library connects Seepient to every AI provider, which makes it the most security-sensitive dependency in the product, so the upgrade went through a file-by-file review of both versions before any code moved. Findings that mattered to users:

- The credential-handling code is byte-identical between the two versions. Keys stored through provider management are handled by exactly the same code as before; the environment-variable fallback that was demolished in earlier releases remains dead.
- No new network endpoints, no new transitive dependencies.
- Picture generation was rebuilt against the library's new model interface (the old one was deleted upstream). Same requests, same artifacts, same typed errors.
- One real fix came out of the release review: provider picture failures (a revoked key, for example) previously would have been treated as retryable, sending the same doomed request at every other configured provider account. They now classify correctly and fail fast.

Image model listings are unchanged: all 55 models available before the upgrade remain available, verified by a pinned inventory (models the vendor added since flow through as usual). Z.ai accounts never had picture models through this path and still don't; that was true before this release too.

## Upgrade notes

- Pull and rebuild. No configuration, credential, tenant, or client changes of any kind.

## Verification

Eleven behavior pins cover the ported path (kind lookup, artifact parity, classified failures, abort/timeout, credential sentinel, egress deny/allow in multi-tenant mode), each proven to fail against the wrong implementation. A supply-chain review diffed both vendor versions file by file. The independent release-gate reviewers (code review plus adversarial red team with live probes) confirmed the boundary holds; their one confirmed finding (the failure-classification repair above) was fixed and re-verified before this release. Full suite, tamper probes, examples, and build green at the release commit; the gate receipt is recorded in the project's internal review vault.
