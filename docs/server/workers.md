---
title: Worker scheduler
description: Distributed worker scheduler, ephemeral Docker worker containers, and mTLS signed dispatches.
---

# Worker scheduler

In distributed deployments and multi-tenant cloud architectures, Seepient isolates tool execution from the control plane using the **Worker Scheduler**.

Rather than executing shell commands or file modifications within the same process that handles user authentication and provider API keys, the server delegates tool execution to ephemeral Docker worker containers.

<DiagramFlow
  :steps="[
    { title: 'Seepient Control Plane', desc: 'REST / WebSocket server — holds API keys and user sessions' },
    { title: 'Docker Worker Scheduler', desc: 'The only component with access to the Docker socket', edge: 'mTLS · signed WorkerDispatch payload' },
    { title: 'Isolated Worker Container', desc: 'Secret-free: runs the command inside the sandbox jail with zero provider credentials', edge: 'Spawns an ephemeral container' }
  ]"
/>
---

## Security invariants

1. **Process and credential isolation**: The process holding LLM provider credentials is never the process executing model-authored shell commands.
2. **Restricted socket access**: Only the trusted worker scheduler service accesses the Docker container-runtime socket. The user-facing control plane and worker containers cannot access Docker.
3. **Secret-free workers**: Worker containers receive no provider API keys, no user session database credentials, and no external tokens. They receive only a short-lived, single-use signed dispatch payload.
4. **mTLS transport**: All communication between the control plane and worker scheduler requires mutual TLS with verified certificate identities.

---

## The WorkerDispatch protocol

When a prepared action requires execution in worker mode:

1. **Dispatch generation**: The control plane creates a `WorkerDispatch` payload containing:
   - A unique, single-use `dispatchId` and cryptographic `nonce`
   - The exact `PreparedToolAction` definition
   - A `WorkspaceLease` binding the container to the tenant's mounted workspace folder
   - Resource constraints (CPU limits, memory limits, execution timeout)
2. **Scheduler validation**: The worker scheduler validates the caller's mTLS certificate, checks workspace leases, and records the nonce to prevent replay attacks.
3. **Ephemeral container execution**: The scheduler launches an isolated worker container running the compiled native sandbox and commit helpers.
4. **Evidence collection**: The worker records execution exit codes, stdout, stderr, and enforcement evidence, returning the signed result to the scheduler.
5. **Teardown**: The container is destroyed immediately after the action completes or times out.

---

## Configuring worker execution

To enable Docker worker execution in your server configuration:

```json
{
  "execution": {
    "backend": "docker-worker",
    "schedulerEndpoint": "https://scheduler.internal:8443",
    "mtls": {
      "caCertPath": "/etc/seepient/certs/ca.pem",
      "clientCertPath": "/etc/seepient/certs/client.pem",
      "clientKeyPath": "/etc/seepient/certs/client-key.pem"
    },
    "workerImage": "seepient/worker:latest",
    "defaultTimeoutMs": 30000
  }
}
```

---

## Layered network defense

When deploying worker containers in cloud environments (AWS, GCP, Azure, Kubernetes):

1. **Application-layer controls (Seepient)**:
   - **Socket IP pinning**: Outbound HTTP requests through `safeSsrfFetch` resolve hostnames, validate resolved IP addresses against private and link-local ranges, and pin the socket to the validated IP using `pinnedFetch`. This stops time-of-check to time-of-use (TOCTOU) DNS rebinding.
   - **Strict range validation**: RFC 1918, link-local (`169.254.169.254`), loopback, documentation/carrier-grade NAT (`192.0.0.0/24`, `198.18.0.0/15`), multicast, and mapped IPv6 ranges are blocked by default.
   - **Redirect bounding**: HTTP redirects are capped at 5 hops; every hop is independently re-validated and re-pinned.

2. **Infrastructure-layer controls (Embedder)**:
   - **IMDSv2 enforcement**: Configure container hosts or worker VMs to enforce IMDSv2 with hop limit = 1. This prevents worker containers from accessing instance metadata even if they share network namespaces.
   - **Egress segmentation**: Restrict worker container egress using VPC security groups, network policies, or firewall rules to isolate workers from internal control plane services and databases.
   - **Complementary roles**: Application-layer socket pinning protects loopback sidecars and non-IMDSv2 metadata services; network egress segmentation and IMDSv2 prevent external data exfiltration and cloud credential theft.

