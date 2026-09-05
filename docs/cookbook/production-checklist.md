---
title: Production checklist
description: Security, reliability, and ops checklist for deploying Seepient in production.
---

# Production checklist

Review this checklist before deploying Seepient in production environments.

---

## Security and permissions

- [ ] **Consent mode configured**: Set `SEEPIENT_CONSENT_MODE` to `autonomous-trusted` for automated workers, or `always-ask` when an interactive operator is present.
- [ ] **Sandboxing enabled**: Ensure `bubblewrap` is installed on Linux hosts (`bwrap --version`), or run inside isolated Docker worker containers.
- [ ] **Exact commit enforcement active**: Confirm the native helper (`seepient-fs-commit`) is compiled and present in your deployment image. Do not disable pre-image hash verification.
- [ ] **Audit log persisted**: Ensure `~/.seepient/audit.log` (or your custom `SEEPIENT_AUDIT_LOG` path) mounts to a persistent volume with `0600` permissions.
- [ ] **Secret isolation**: Verify that container worker environments do not inherit provider API keys or cloud metadata instance credentials.
- [ ] **Network egress restrictions**: Block outbound access to cloud metadata IP (`169.254.169.254`) and internal control-plane ports.

---

## Storage and persistence

- [ ] **Stateless mode verified**: If running in serverless or multi-tenant containers, inject all required store contracts (`sessionStore`, `auditStore`, `policyStore`, `capabilityLedger`) to guarantee zero local disk writes.
- [ ] **Session retention schedule**: Configure expiration or archival policies for completed session histories in your database.
- [ ] **File-lock concurrency**: If sharing session directories across processes, confirm the filesystem supports POSIX file locks (`fcntl`).

---

## Reliability and routing

- [ ] **Fallback chains configured**: Define secondary model providers in `PurposeModelMap` to handle upstream rate limits (HTTP 429) or outages.
- [ ] **Circuit breaker cooldowns**: Verify error thresholds prevent tight retry loops against failing providers.
- [ ] **Step limits**: Set a sensible `maxSteps` limit (for example, 15 turns) to prevent runaway agent loops if a tool returns unexpected output.
- [ ] **Abort signals wired**: Pass `AbortSignal` through to SDK generation calls so user cancellations immediately abort upstream HTTP connections.

---

## Monitoring and observability

- [ ] **Health endpoint monitored**: Set up uptime checks on `GET /v1/health`.
- [ ] **Token and cost telemetry**: Ingest token usage metrics (`inputTokens`, `outputTokens`, `reasoningTokens`) into your observability stack.
- [ ] **Audit log streaming**: Forward audit records to your SIEM or centralized log collector for compliance tracking.
