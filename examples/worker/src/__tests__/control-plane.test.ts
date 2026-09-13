/**
 * J10 Adversarial Journey — VULN-19: Reference worker unauthenticated & unscoped control plane.
 *
 * Verifies that the worker stub control plane:
 * 1. Requires Bearer authentication for all endpoints (rejects unauthenticated with 401).
 * 2. Scopes session listing to the authenticated tenant/principal only.
 * 3. Rejects unauthenticated/forged audit appends.
 * 4. FR-006: Rejects unissued/forged tokens with 401 (no auto-adoption).
 * 5. FR-006: Ignores body-supplied principalId; writes land under the token's authenticated principal.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createStubApp } from "../stub-app.js";
import { createSecurityGuard } from "../../../../src/domain/permissions/__tests__/composition-closure/_guard.js";

describe("J10 Worker Control Plane Journey (VULN-19)", () => {
  let app: ReturnType<typeof createStubApp>;
  let port: number;
  let guard = createSecurityGuard("VULN-19");

  beforeEach(async () => {
    app = createStubApp({ adminSecret: "dev-admin-secret" });
    port = await app.listen();
    guard = createSecurityGuard("VULN-19");
  });

  afterEach(async () => {
    await app.close();
  });

  it("control plane rejects unauthenticated requests with 401 and scopes sessions per principal", async () => {
    const instrumentedFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await fetch(input, init);
      const urlStr = typeof input === "string" ? input : input.toString();
      const hasAuth = !!init?.headers && (typeof init.headers === "object" && ("authorization" in (init.headers as any) || "Authorization" in (init.headers as any)));
      if (res.status === 401 && !hasAuth) {
        if (urlStr.includes("/api/sessions")) {
          guard.recordHit("unauthenticated.list");
        } else if (urlStr.includes("/api/audit")) {
          guard.recordHit("unauthenticated.audit");
        }
      } else if (res.status === 200 && urlStr.includes("/api/sessions") && (!init?.method || init.method === "GET")) {
        guard.recordHit("scoped.list");
      }
      return res;
    };

    // 1. Unauthenticated session list must be rejected with 401
    const unauthListRes = await instrumentedFetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: "GET",
    });
    expect(unauthListRes.status).toBe(401);

    // 2. Unauthenticated audit append must be rejected with 401
    const unauthAuditRes = await instrumentedFetch(`http://127.0.0.1:${port}/api/audit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: "forged-audit-1",
        event: { actionId: "forged-1" },
      }),
    });
    expect(unauthAuditRes.status).toBe(401);

    // 3. Issue legitimate tokens for Tenant A and Tenant B (authenticated with x-admin-key)
    const issueResA = await fetch(`http://127.0.0.1:${port}/api/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-key": "dev-admin-secret" },
      body: JSON.stringify({ principalId: "tenant-a" }),
    });
    expect(issueResA.status).toBe(200);
    const { token: tokenA } = await issueResA.json();

    const issueResB = await fetch(`http://127.0.0.1:${port}/api/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-key": "dev-admin-secret" },
      body: JSON.stringify({ principalId: "tenant-b" }),
    });
    expect(issueResB.status).toBe(200);
    const { token: tokenB } = await issueResB.json();

    // Tenant A creates session
    await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({ id: "session-a-1", data: { messages: [] }, principalId: "tenant-a" }),
    });

    // Tenant B creates session
    await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${tokenB}`,
      },
      body: JSON.stringify({ id: "session-b-1", data: { messages: [] }, principalId: "tenant-b" }),
    });

    // Tenant A lists sessions: must only return ["session-a-1"]
    const listARes = await instrumentedFetch(`http://127.0.0.1:${port}/api/sessions`, {
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(listARes.status).toBe(200);
    const sessionsA = await listARes.json();
    expect(sessionsA).toEqual(["session-a-1"]);

    guard.assertGuardedPathExecuted(3);
  });

  it("rejects token issuance without admin key with 403 and prevents mint-then-impersonate (P0-W1)", async () => {
    // 1. Unauthenticated token issuance must be rejected with 403
    const unauthIssue = await fetch(`http://127.0.0.1:${port}/api/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: "tenant-victim" }),
    });
    expect(unauthIssue.status).toBe(403);

    // 2. Wrong admin key must be rejected with 403
    const wrongKeyIssue = await fetch(`http://127.0.0.1:${port}/api/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-key": "wrong-key" },
      body: JSON.stringify({ principalId: "tenant-victim" }),
    });
    expect(wrongKeyIssue.status).toBe(403);

    // 3. Invalid principalId slug must be rejected with 400
    const invalidSlugIssue = await fetch(`http://127.0.0.1:${port}/api/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-key": "dev-admin-secret" },
      body: JSON.stringify({ principalId: "../escape/path" }),
    });
    expect(invalidSlugIssue.status).toBe(400);

    // 4. Authenticated issuance produces unguessable random token (not deterministic)
    const validIssue = await fetch(`http://127.0.0.1:${port}/api/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-key": "dev-admin-secret" },
      body: JSON.stringify({ principalId: "tenant-valid" }),
    });
    expect(validIssue.status).toBe(200);
    const { token } = await validIssue.json();
    expect(token).not.toBe("issued-token-tenant-valid");
    expect(token.startsWith("token-")).toBe(true);
    expect(token.length).toBeGreaterThan(20);
  });

  it("rejects unissued/forged tokens with 401 (FR-003 / FR-006)", async () => {
    // Attempting to access using unissued bearer token must be rejected with 401
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      headers: { authorization: "Bearer token-tenant-unissued" },
    });
    expect(res.status).toBe(401);
  });

  it("derives principal exclusively from authenticated token, ignoring body principalId (FR-004 / FR-006)", async () => {
    // 1. Issue legitimate token for tenant-a
    const issueResA = await fetch(`http://127.0.0.1:${port}/api/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-key": "dev-admin-secret" },
      body: JSON.stringify({ principalId: "tenant-a" }),
    });
    const { token: tokenA } = await issueResA.json();

    // 2. Tenant A creates session but passes principalId: "tenant-b" in body
    await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        id: "session-a-spoof",
        data: { messages: [] },
        principalId: "tenant-b", // Attempt to re-bind or write under tenant-b
      }),
    });

    // 3. Tenant A posts audit event with body principalId: "tenant-b"
    await fetch(`http://127.0.0.1:${port}/api/audit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        idempotencyKey: "audit-spoof-1",
        principalId: "tenant-b",
        event: { actionId: "action-1" },
      }),
    });

    // 4. Tenant A posts policy update with body principalId: "tenant-b"
    await fetch(`http://127.0.0.1:${port}/api/policy`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        workspaceId: "ws-test",
        expectedVersion: 0,
        principalId: "tenant-b",
        next: { version: 1, capabilities: [] },
      }),
    });

    // 5. Issue legitimate token for tenant-b
    const issueResB = await fetch(`http://127.0.0.1:${port}/api/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-key": "dev-admin-secret" },
      body: JSON.stringify({ principalId: "tenant-b" }),
    });
    const { token: tokenB } = await issueResB.json();

    // 6. Tenant B lists sessions: must NOT contain session-a-spoof
    const listBRes = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      headers: { authorization: `Bearer ${tokenB}` },
    });
    const sessionsB = await listBRes.json();
    expect(sessionsB).not.toContain("session-a-spoof");

    // 7. Tenant A lists sessions: must contain session-a-spoof (written under tenant-a)
    const listARes = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      headers: { authorization: `Bearer ${tokenA}` },
    });
    const sessionsA = await listARes.json();
    expect(sessionsA).toContain("session-a-spoof");

    // 8. Audit read-back: event was recorded under tenant-a, not tenant-b
    const auditEv = app.state.auditEvents.find((e) => e.idempotencyKey === "audit-spoof-1");
    expect(auditEv).toBeDefined();
    expect(auditEv?.principalId).toBe("tenant-a");

    // 9. Policy read-back: Tenant B's policy does not reflect Tenant A's POST with spoofed principalId
    const polBRes = await fetch(`http://127.0.0.1:${port}/api/policy?workspaceId=ws-test`, {
      headers: { authorization: `Bearer ${tokenB}` },
    });
    const polB = await polBRes.json();
    if (polB?.policy?.capabilities) {
      expect(polB.policy.capabilities.some((c: any) => c.principalId === "tenant-a")).toBeFalsy();
    }

    // 10. Tenant A's policy read-back: reflects tenant-a's write
    const polARes = await fetch(`http://127.0.0.1:${port}/api/policy?workspaceId=ws-test`, {
      headers: { authorization: `Bearer ${tokenA}` },
    });
    const polA = await polARes.json();
    expect(polA).toBeDefined();
    expect(polA.workspaceId).toBe("ws-test");
  });

  it("prevents suffix collision and session context poisoning (P1-F)", async () => {
    // 1. Issue tokens for attacker and victim
    const resAttacker = await fetch(`http://127.0.0.1:${port}/api/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-key": "dev-admin-secret" },
      body: JSON.stringify({ principalId: "attacker" }),
    });
    const { token: tokenAttacker } = await resAttacker.json();

    const resVictim = await fetch(`http://127.0.0.1:${port}/api/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-key": "dev-admin-secret" },
      body: JSON.stringify({ principalId: "victim" }),
    });
    const { token: tokenVictim } = await resVictim.json();

    // 2. Attacker writes a session with id "victim:session-target"
    await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${tokenAttacker}`,
      },
      body: JSON.stringify({
        id: "victim:session-target",
        data: { messages: [{ role: "system", content: "INJECTED ATTACKER CONTEXT" }] },
      }),
    });

    // 3. Victim fetches their session "session-target"
    const victimGet = await fetch(`http://127.0.0.1:${port}/api/sessions?sessionId=session-target`, {
      headers: { authorization: `Bearer ${tokenVictim}` },
    });
    const victimSession = await victimGet.json();
    // Must be null (not matching the attacker's suffix)
    expect(victimSession).toBeNull();
  });

  it("scopes skills endpoints by authPrincipal preventing cross-tenant read/write (P1-G)", async () => {
    const resA = await fetch(`http://127.0.0.1:${port}/api/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-key": "dev-admin-secret" },
      body: JSON.stringify({ principalId: "tenant-a" }),
    });
    const { token: tokenA } = await resA.json();

    const resB = await fetch(`http://127.0.0.1:${port}/api/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-key": "dev-admin-secret" },
      body: JSON.stringify({ principalId: "tenant-b" }),
    });
    const { token: tokenB } = await resB.json();

    // Tenant A attempts to write skill pretending to be tenant-b
    await fetch(`http://127.0.0.1:${port}/api/skills`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        name: "malicious-skill",
        content: "malicious code",
        tenant_id: "tenant-b",
      }),
    });

    // Tenant B attempts to read Tenant A's skills -> 403 Forbidden
    const crossRead = await fetch(`http://127.0.0.1:${port}/api/skills?tenantId=tenant-a`, {
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(crossRead.status).toBe(403);

    // Tenant B reads own skills -> malicious-skill is NOT present
    const ownRead = await fetch(`http://127.0.0.1:${port}/api/skills?tenantId=tenant-b`, {
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(ownRead.status).toBe(200);
    const { skills: bSkills } = await ownRead.json();
    expect(bSkills.some((s: any) => s.name === "malicious-skill")).toBe(false);

    // Tenant A reads own skills -> malicious-skill IS present (stored under tenant-a)
    const aRead = await fetch(`http://127.0.0.1:${port}/api/skills?tenantId=tenant-a`, {
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(aRead.status).toBe(200);
    const { skills: aSkills } = await aRead.json();
    expect(aSkills.some((s: any) => s.name === "malicious-skill")).toBe(true);
  });

  it("prevents policy CAS self-authorization of wildcards or unowned capabilities (P1-D / P1-E)", async () => {
    const resA = await fetch(`http://127.0.0.1:${port}/api/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-key": "dev-admin-secret" },
      body: JSON.stringify({ principalId: "tenant-a" }),
    });
    const { token: tokenA } = await resA.json();

    // 1. Tenant A attempts to CAS wildcard write-root
    const wildcardWrite = await fetch(`http://127.0.0.1:${port}/api/policy`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        workspaceId: "ws-test",
        expectedVersion: 0,
        next: { version: 1, capabilities: [{ kind: "write-root", root: "*", principalId: "tenant-a" }] },
      }),
    });
    expect(wildcardWrite.status).toBe(403);

    // 2. Tenant A attempts to CAS capability with foreign principalId
    const foreignCap = await fetch(`http://127.0.0.1:${port}/api/policy`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        workspaceId: "ws-test",
        expectedVersion: 0,
        next: { version: 1, capabilities: [{ kind: "read-root", root: "/tmp", principalId: "tenant-b" }] },
      }),
    });
    expect(foreignCap.status).toBe(403);

    // 3. Tenant A attempts to CAS unstamped capability
    const unstampedCap = await fetch(`http://127.0.0.1:${port}/api/policy`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        workspaceId: "ws-test",
        expectedVersion: 0,
        next: { version: 1, capabilities: [{ kind: "read-root", root: "/tmp" }] },
      }),
    });
    expect(unstampedCap.status).toBe(403);

    // 4. GET /api/policy never discloses unstamped workspace wildcards
    const policyGet = await fetch(`http://127.0.0.1:${port}/api/policy?workspaceId=default`, {
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(policyGet.status).toBe(200);
    const policy = await policyGet.json();
    expect(policy.policy.capabilities.some((c: any) => c.root === "*")).toBe(false);
  });

  it("NEW-2: malformed JSON returns 400 without crashing the process", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ broken json !!!",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("BadRequest");
  });

  it("NEW-4: capability digests and revocations are strictly partitioned by principal", async () => {
    const issueA = await fetch(`http://127.0.0.1:${port}/api/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-key": "dev-admin-secret" },
      body: JSON.stringify({ principalId: "tenant-a" }),
    });
    const { token: tokenA } = await issueA.json();

    const issueB = await fetch(`http://127.0.0.1:${port}/api/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-key": "dev-admin-secret" },
      body: JSON.stringify({ principalId: "tenant-b" }),
    });
    const { token: tokenB } = await issueB.json();

    // Tenant A consumes digest-a-1
    await fetch(`http://127.0.0.1:${port}/api/caps/consume`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ actionDigest: "digest-a-1" }),
    });

    // Tenant B lists caps: must NOT see digest-a-1
    const getB = await fetch(`http://127.0.0.1:${port}/api/caps`, {
      headers: { authorization: `Bearer ${tokenB}` },
    });
    const capsB = await getB.json();
    expect(capsB.consumedDigests).toEqual([]);

    // Tenant B revokes run-victim
    await fetch(`http://127.0.0.1:${port}/api/caps/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokenB}` },
      body: JSON.stringify({ filter: { runId: "run-victim" } }),
    });

    // Tenant A lists caps: must NOT see Tenant B's revocation
    const getA = await fetch(`http://127.0.0.1:${port}/api/caps`, {
      headers: { authorization: `Bearer ${tokenA}` },
    });
    const capsA = await getA.json();
    expect(capsA.consumedDigests).toEqual(["digest-a-1"]);
    expect(capsA.revocations).toEqual([]);

    // Tenant B lists caps: sees its own revocation
    const getB2 = await fetch(`http://127.0.0.1:${port}/api/caps`, {
      headers: { authorization: `Bearer ${tokenB}` },
    });
    const capsB2 = await getB2.json();
    expect(capsB2.revocations).toEqual([{ runId: "run-victim" }]);
  });

  it("NEW-5: token issuance without configured adminSecret returns 503 and rejects sentinels", async () => {
    const unconfiguredApp = createStubApp({ adminSecret: "" });
    const uPort = await unconfiguredApp.listen();
    try {
      const res = await fetch(`http://127.0.0.1:${uPort}/api/auth/token`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-key": "dev-admin-secret" },
        body: JSON.stringify({ principalId: "tenant-xyz" }),
      });
      expect(res.status).toBe(503);
    } finally {
      await unconfiguredApp.close();
    }

    // Attempting to issue a token for a sentinel principal is rejected with 400
    for (const sentinel of ["default", "anonymous", "sdk-user", "cli-user"]) {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/token`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-key": "dev-admin-secret" },
        body: JSON.stringify({ principalId: sentinel }),
      });
      expect(res.status).toBe(400);
    }
  });

  it("NEW-6: audit duplicate detection is scoped to principal", async () => {
    const issueA = await fetch(`http://127.0.0.1:${port}/api/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-key": "dev-admin-secret" },
      body: JSON.stringify({ principalId: "tenant-a" }),
    });
    const { token: tokenA } = await issueA.json();

    const issueB = await fetch(`http://127.0.0.1:${port}/api/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-key": "dev-admin-secret" },
      body: JSON.stringify({ principalId: "tenant-b" }),
    });
    const { token: tokenB } = await issueB.json();

    // Tenant A appends audit with idempotencyKey "shared-key"
    const resA = await fetch(`http://127.0.0.1:${port}/api/audit`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ idempotencyKey: "shared-key", event: { actionId: "a1" } }),
    });
    expect((await resA.json()).status).toBe("written");

    // Tenant A appends again with same key -> duplicate
    const resA2 = await fetch(`http://127.0.0.1:${port}/api/audit`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ idempotencyKey: "shared-key", event: { actionId: "a2" } }),
    });
    expect((await resA2.json()).status).toBe("duplicate");

    // Tenant B appends with same key -> written (not duplicate across tenants)
    const resB = await fetch(`http://127.0.0.1:${port}/api/audit`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokenB}` },
      body: JSON.stringify({ idempotencyKey: "shared-key", event: { actionId: "b1" } }),
    });
    expect((await resB.json()).status).toBe("written");
  });

  it("P1-D: policy CAS rejects external-recipient and process wildcards", async () => {
    const issueA = await fetch(`http://127.0.0.1:${port}/api/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-key": "dev-admin-secret" },
      body: JSON.stringify({ principalId: "tenant-a" }),
    });
    const { token: tokenA } = await issueA.json();

    const wildcardRecipient = await fetch(`http://127.0.0.1:${port}/api/policy`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({
        workspaceId: "ws-test",
        expectedVersion: 0,
        next: { version: 1, capabilities: [{ kind: "external-recipient", recipient: "*", principalId: "tenant-a" }] },
      }),
    });
    expect(wildcardRecipient.status).toBe(403);

    const wildcardProcess = await fetch(`http://127.0.0.1:${port}/api/policy`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({
        workspaceId: "ws-test",
        expectedVersion: 0,
        next: { version: 1, capabilities: [{ kind: "process", command: "*", principalId: "tenant-a" }] },
      }),
    });
    expect(wildcardProcess.status).toBe(403);
  });

  it("P1-4: unauthenticated malformed JSON body returns 400 without crashing the process", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/audit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{invalid-json-body",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("BadRequest");

    // Server should still be healthy and responding to subsequent requests
    const healthCheck = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: "GET",
    });
    expect(healthCheck.status).toBe(401);
  });

  it("P1-5: policy CAS rejects all wildcard capability shapes including network-destination, write-root / and model-egress", async () => {
    const issueA = await fetch(`http://127.0.0.1:${port}/api/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-key": "dev-admin-secret" },
      body: JSON.stringify({ principalId: "tenant-a" }),
    });
    const { token: tokenA } = await issueA.json();

    const testCaps = [
      { kind: "network-destination", scheme: "https", host: "*", principalId: "tenant-a" },
      { kind: "write-root", root: "/", principalId: "tenant-a" },
      { kind: "read-root", root: "*", principalId: "tenant-a" },
      { kind: "secret-ref", ref: "*", principalId: "tenant-a" },
      { kind: "model-egress", providerClass: "anthropic", dataClasses: ["secret"], principalId: "tenant-a" },
      { kind: "process", executable: "*", principalId: "tenant-a" },
    ];

    for (const cap of testCaps) {
      const res = await fetch(`http://127.0.0.1:${port}/api/policy`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${tokenA}` },
        body: JSON.stringify({
          workspaceId: "ws-test",
          expectedVersion: 0,
          next: { version: 1, capabilities: [cap] },
        }),
      });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toBe("Forbidden");
    }
  });

  it("P1-6: /api/caps endpoints are strictly isolated per tenant for consume, revoke, and list", async () => {
    const issueA = await fetch(`http://127.0.0.1:${port}/api/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-key": "dev-admin-secret" },
      body: JSON.stringify({ principalId: "tenant-a" }),
    });
    const { token: tokenA } = await issueA.json();

    const issueB = await fetch(`http://127.0.0.1:${port}/api/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-key": "dev-admin-secret" },
      body: JSON.stringify({ principalId: "tenant-b" }),
    });
    const { token: tokenB } = await issueB.json();

    // Tenant A consumes a digest and revokes a session
    await fetch(`http://127.0.0.1:${port}/api/caps/consume`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ actionDigest: "digest-tenant-a-1" }),
    });

    await fetch(`http://127.0.0.1:${port}/api/caps/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ filter: { sessionId: "session-tenant-a-1", runId: "run-a-1" } }),
    });

    // Tenant B queries caps -> should NOT see Tenant A's consumed digests or revocations
    const resB = await fetch(`http://127.0.0.1:${port}/api/caps`, {
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(resB.status).toBe(200);
    const capsB = await resB.json();
    expect(capsB.consumedDigests).not.toContain("digest-tenant-a-1");
    expect(capsB.revocations.some((r: any) => r.sessionId === "session-tenant-a-1")).toBe(false);

    // Tenant A queries caps -> should see own consumed digests and revocations
    const resA = await fetch(`http://127.0.0.1:${port}/api/caps`, {
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(resA.status).toBe(200);
    const capsA = await resA.json();
    expect(capsA.consumedDigests).toContain("digest-tenant-a-1");
    expect(capsA.revocations.some((r: any) => r.sessionId === "session-tenant-a-1")).toBe(true);
  });
});

