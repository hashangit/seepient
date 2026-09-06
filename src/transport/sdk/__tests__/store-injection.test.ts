/**
 * QS-1 — Injection + Session round-trip (Spec 021 P0 gate).
 *
 * Verifies:
 * 1. Two agents in one process with distinct injected stores and principals
 *    produce completely disjoint audit, policy, and capability ledger state.
 * 2. Custom AuditStore skips outbox and flushAudit() returns 0.
 * 3. Seepient exposes sessionId and validates it fail-fast against SESSION_ID_RE.
 * 4. Session round-trip via sessionId restores conversation history and
 *    passes provider, model, and metadata on every persist.
 * 5. Session resume is bound to the owning principalId — cross-tenant and
 *    unstamped (legacy) resumes fail closed with SESSION_OWNERSHIP_MISMATCH.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSeepient, askSeepient } from "../index.js";
import {
  FakeAuditStore,
  FakePolicyStore,
  FakeCapabilityLedger,
  RecordingPersistenceBackend,
  createFakeRuntime,
} from "./helpers/fake-stores.js";

describe("QS-1: Store injection and session round-trip", () => {
  let workspaceA: string;
  let workspaceB: string;

  beforeEach(() => {
    workspaceA = realpathSync(mkdtempSync(join(tmpdir(), "seepient-qs1-a-")));
    workspaceB = realpathSync(mkdtempSync(join(tmpdir(), "seepient-qs1-b-")));
  });

  afterEach(() => {
    rmSync(workspaceA, { recursive: true, force: true });
    rmSync(workspaceB, { recursive: true, force: true });
  });

  it("two agents in one process with injected stores produce disjoint state", async () => {
    const auditA = new FakeAuditStore();
    const policyA = new FakePolicyStore();
    const ledgerA = new FakeCapabilityLedger();
    const configA = new (await import("../../../domain/providers/config-store/provider-config-store.js")).ProviderConfigStore(":memory:");
    const credA = new (await import("../../../domain/providers/credentials/composite-credential-store.js")).CompositeCredentialStore({
      memory: new (await import("../../../domain/providers/credentials/memory-credential-store.js")).MemoryCredentialStore(),
      primaryWriteStore: "memory",
    });
    const configB = new (await import("../../../domain/providers/config-store/provider-config-store.js")).ProviderConfigStore(":memory:");
    const credB = new (await import("../../../domain/providers/credentials/composite-credential-store.js")).CompositeCredentialStore({
      memory: new (await import("../../../domain/providers/credentials/memory-credential-store.js")).MemoryCredentialStore(),
      primaryWriteStore: "memory",
    });

    const runtimeA = createFakeRuntime({
      configStore: configA,
      credentialStore: credA,
      responses: [
        {
          toolCalls: [
            {
              id: "call-a",
              name: "write_file",
              args: { path: join(workspaceA, "a.txt"), content: "from agent A" },
            },
          ],
        },
        { content: "Agent A done" },
      ],
    });

    const auditB = new FakeAuditStore();
    const policyB = new FakePolicyStore();
    const ledgerB = new FakeCapabilityLedger();
    const runtimeB = createFakeRuntime({
      configStore: configB,
      credentialStore: credB,
      responses: [
        {
          toolCalls: [
            {
              id: "call-b",
              name: "write_file",
              args: { path: join(workspaceB, "b.txt"), content: "from agent B" },
            },
          ],
        },
        { content: "Agent B done" },
      ],
    });

    const agentA = await createSeepient({
      principalId: "tenant-alpha",
      auditStore: auditA,
      policyStore: policyA,
      capabilityLedger: ledgerA,
      runtime: runtimeA,
      cwd: workspaceA,
      model: "mock-model-a",
    });

    const agentB = await createSeepient({
      principalId: "tenant-beta",
      auditStore: auditB,
      policyStore: policyB,
      capabilityLedger: ledgerB,
      runtime: runtimeB,
      cwd: workspaceB,
      model: "mock-model-b",
    });

    const spyResolveA = vi.spyOn(credA, "resolve");
    const spyResolveB = vi.spyOn(credB, "resolve");

    const resA = await agentA.chat("Task for A");

    // Behavioral isolation: agentA's turn consulted credA, never credB
    expect(spyResolveA).toHaveBeenCalled();
    expect(spyResolveB).not.toHaveBeenCalled();

    const resB = await agentB.chat("Task for B");
    expect(spyResolveB).toHaveBeenCalled();

    expect(resA.text).toContain("Agent A done");
    expect(resB.text).toContain("Agent B done");

    // Runtime credential and config separation
    expect(runtimeA.getConfigStore()).toBe(configA);
    expect(runtimeB.getConfigStore()).toBe(configB);
    expect(runtimeA.getCredentialStore()).toBe(credA);
    expect(runtimeB.getCredentialStore()).toBe(credB);

    // Audit separation: auditA has events for tenant-alpha only
    expect(auditA.appends.length).toBeGreaterThan(0);
    for (const record of auditA.appends) {
      expect(record.event.principalId).toBe("tenant-alpha");
    }

    // Audit separation: auditB has events for tenant-beta only
    expect(auditB.appends.length).toBeGreaterThan(0);
    for (const record of auditB.appends) {
      expect(record.event.principalId).toBe("tenant-beta");
    }

    // Policy separation: mutate policyA, assert policyB remains unmutated
    await policyA.compareAndSet(
      workspaceA,
      0,
      { version: 1, capabilities: [{ kind: "write-root", root: "/tmp/a" }] },
      { kind: "principal", authorityId: "tenant-alpha", authenticatedBy: "test" },
    );
    const snapA = await policyA.read(workspaceA);
    const snapB = await policyB.read(workspaceB);
    expect(snapA.version).toBe(1);
    expect(snapB.version).toBe(0);
    expect(snapB.policy.capabilities).toEqual([]);

    // Custom store flushAudit() returns 0 (appends are already durable)
    const flushCountA = await agentA.flushAudit();
    expect(flushCountA).toBe(0);

    await agentA.close();
    await agentB.close();
  });

  it("fails fast on invalid sessionId format", async () => {
    await expect(
      createSeepient({
        sessionId: "invalid/session/id",
      }),
    ).rejects.toThrow(/Invalid session ID/);
  });

  it("exposes sessionId and round-trips conversation history with clean metadata and providerAccount", async () => {
    const backend = new RecordingPersistenceBackend();
    const runtime = createFakeRuntime({
      responses: (req) => {
        const lastUser = req.messages?.filter((m: any) => m.role === "user").pop();
        const text = typeof lastUser?.content === "string"
          ? lastUser.content
          : Array.isArray(lastUser?.content)
            ? lastUser.content.map((c: any) => c.text ?? "").join("")
            : "";
        return { content: `Echo: ${text}` };
      },
    });

    const customSessionId = "tenant-42-session-7";
    const customMetadata = { tenantId: "tenant-42", env: "production" };

    const agent1 = await createSeepient({
      sessionId: customSessionId,
      persist: backend,
      metadata: customMetadata,
      runtime,
      model: "test-model",
      provider: "test-provider",
    });

    await agent1.switchProvider("mock-account", "test-model");
    await agent1.chat("Message 1");
    await agent1.chat("Message 2");

    // Verify saves in backend: providerAccount is first-class, metadata untouched
    expect(backend.saves.length).toBe(2);
    const lastSave = backend.saves[backend.saves.length - 1];
    expect(lastSave.id).toBe(customSessionId);
    expect(lastSave.data.provider).toBe("test-provider");
    expect(lastSave.data.providerAccount).toBe("mock-account");
    expect(lastSave.data.model).toBe("test-model");
    expect(lastSave.data.metadata).toEqual(customMetadata);

    await agent1.close();

    // Create a new agent with the SAME sessionId and backend
    const agent2 = await createSeepient({
      sessionId: customSessionId,
      persist: backend,
      runtime,
      model: "test-model",
    });

    expect(agent2.sessionId).toBe(customSessionId);
    const history = agent2.getHistory();
    const userMessages = history.filter((m) => m.role === "user").map((m) => m.content);
    expect(userMessages).toContain("Message 1");
    expect(userMessages).toContain("Message 2");

    // Resumed agent can chat and produces a fresh response (N1 regression guard)
    const res3 = await agent2.chat("Message 3");
    expect(res3.text).toBe("Echo: Message 3");
    expect(agent2.getUsage().requestCount).toBe(1);

    const historyAfter = agent2.getHistory();
    const userMessagesAfter = historyAfter.filter((m) => m.role === "user").map((m) => m.content);
    expect(userMessagesAfter).toEqual(["Message 1", "Message 2", "Message 3"]);

    await agent2.close();
  });

  it("abort() resolves chat() with partial response and does not throw (F2)", async () => {
    const runtime = createFakeRuntime({
      responses: [
        {
          toolCalls: [{ id: "call-1", name: "write_file", args: { path: join(workspaceA, "aborted.txt"), content: "partial" } }],
          content: "Partial progress before abort",
        },
      ],
    });

    const agent = await createSeepient({
      runtime,
      cwd: workspaceA,
      model: "mock-model",
    });

    // Chat and immediately abort
    const chatPromise = agent.chat("Long operation");
    agent.abort();

    const res = await chatPromise;
    expect(res).toBeDefined();
    expect(typeof res.text).toBe("string");

    await agent.close();
  });

  it("execution error persists messages and surfaces as SeepientError (F4)", async () => {
    const backend = new RecordingPersistenceBackend();
    const runtime = createFakeRuntime({
      responses: () => ({
        error: { code: "PROVIDER_ERROR", message: "Upstream rate limit" },
      }),
    });

    const agent = await createSeepient({
      sessionId: "err-sess-1",
      persist: backend,
      runtime,
      model: "mock-model",
    });

    await expect(agent.chat("Failing message")).rejects.toThrow(/Upstream rate limit/);

    // Messages were persisted before throw
    expect(backend.saves.length).toBe(1);
    expect(backend.saves[0].data.messages.some((m) => m.role === "user" && m.content === "Failing message")).toBe(true);

    await agent.close();
  });

  it("askSeepient accepts injected runtime and principalId with pipeline enabled by default", async () => {
    const auditStore = new FakeAuditStore();
    const policyStore = new FakePolicyStore();
    const capabilityLedger = new FakeCapabilityLedger();
    const runtime = createFakeRuntime({
      responses: [
        {
          toolCalls: [
            {
              id: "call-gen",
              name: "write_file",
              args: { path: join(workspaceA, "gen.txt"), content: "one-shot" },
            },
          ],
        },
        { content: "One-shot completed." },
      ],
    });

    const result = await askSeepient("Do one-shot task", {
      principalId: "tenant-oneshot",
      auditStore,
      policyStore,
      capabilityLedger,
      runtime,
      cwd: workspaceA,
    });

    expect(result.text).toContain("One-shot completed");
    expect(auditStore.appends.length).toBeGreaterThan(0);
    for (const record of auditStore.appends) {
      expect(record.event.principalId).toBe("tenant-oneshot");
    }
  });

  it("session resumption restores provider, providerAccount, model, and metadata, feeding pipeline and subsequent saves", async () => {
    const backend = new RecordingPersistenceBackend();
    const auditStore = new FakeAuditStore();
    const policyStore = new FakePolicyStore();
    const capabilityLedger = new FakeCapabilityLedger();
    const runtime = createFakeRuntime({
      responses: [
        {
          toolCalls: [{ id: "call-rt-1", name: "write_file", args: { path: join(workspaceA, "roundtrip.txt"), content: "hello" } }],
        },
        { content: "Done" },
      ],
    });

    const sessionId = "session-rt-1";
    // Pre-populate backend with existing session state
    await backend.save(sessionId, {
      id: sessionId,
      messages: [{ id: "msg-1", role: "user", content: "Initial message", timestamp: 1000 }],
      createdAt: 1000,
      updatedAt: 1000,
      principalId: "sdk-user",
      provider: "anthropic",
      providerAccount: "mock-account",
      model: "mock-model",
      metadata: { tenantId: "tenant-99", region: "us-east-1" },
    });

    // Create agent resuming this session WITHOUT providing provider/providerAccount/model/metadata in options
    const agent = await createSeepient({
      sessionId,
      persist: backend,
      runtime,
      cwd: workspaceA,
      auditStore,
      policyStore,
      capabilityLedger,
      consentMode: "autonomous",
    });

    // Chat turn
    const res = await agent.chat("Follow-up turn");
    expect(res.text).toBe("Done");

    // Verify audit event captured tool dispatch
    expect(auditStore.appends.length).toBeGreaterThan(0);

    // Verify last save preserved provider, providerAccount, model, and metadata
    const lastSave = backend.saves[backend.saves.length - 1];
    expect(lastSave.id).toBe(sessionId);
    expect(lastSave.data.provider).toBe("anthropic");
    expect(lastSave.data.providerAccount).toBe("mock-account");
    expect(lastSave.data.model).toBe("mock-model");
    expect(lastSave.data.metadata).toEqual({ tenantId: "tenant-99", region: "us-east-1" });

    await agent.close();
  });

  it("rejects resuming a session under a different principal (tenant isolation)", async () => {
    const backend = new RecordingPersistenceBackend();
    const runtime = createFakeRuntime({ responses: [{ content: "Alpha reply" }] });

    const alpha = await createSeepient({
      sessionId: "sess-tenant-isolation",
      principalId: "tenant-alpha",
      auditStore: new FakeAuditStore(),
      policyStore: new FakePolicyStore(),
      capabilityLedger: new FakeCapabilityLedger(),
      persist: backend,
      runtime,
      model: "mock-model",
    });
    await alpha.chat("alpha confidential message");
    await alpha.close();

    // Saves are stamped with the owning principal
    const lastSave = backend.saves[backend.saves.length - 1];
    expect(lastSave.data.principalId).toBe("tenant-alpha");

    // A different principal cannot resume the session — history stays isolated
    await expect(
      createSeepient({
        sessionId: "sess-tenant-isolation",
        principalId: "tenant-beta",
        auditStore: new FakeAuditStore(),
        policyStore: new FakePolicyStore(),
        capabilityLedger: new FakeCapabilityLedger(),
        persist: backend,
        runtime,
        model: "mock-model",
      }),
    ).rejects.toMatchObject({ code: "SESSION_OWNERSHIP_MISMATCH" });

    // The owning principal still resumes with history intact
    const resumed = await createSeepient({
      sessionId: "sess-tenant-isolation",
      principalId: "tenant-alpha",
      auditStore: new FakeAuditStore(),
      policyStore: new FakePolicyStore(),
      capabilityLedger: new FakeCapabilityLedger(),
      persist: backend,
      runtime,
      model: "mock-model",
    });
    expect(
      resumed.getHistory().some((m) => m.role === "user" && m.content === "alpha confidential message"),
    ).toBe(true);
    await resumed.close();
  });

  it("fails closed when resuming a session persisted without an owner", async () => {
    const backend = new RecordingPersistenceBackend();
    const sessionId = "sess-unstamped-legacy";
    await backend.save(sessionId, {
      id: sessionId,
      messages: [{ id: "msg-legacy", role: "user", content: "legacy message", timestamp: 1000 }],
      createdAt: 1000,
      updatedAt: 1000,
    });

    await expect(
      createSeepient({
        sessionId,
        auditStore: new FakeAuditStore(),
        policyStore: new FakePolicyStore(),
        capabilityLedger: new FakeCapabilityLedger(),
        persist: backend,
        runtime: createFakeRuntime({ responses: [{ content: "unused" }] }),
        model: "mock-model",
      }),
    ).rejects.toMatchObject({ code: "SESSION_OWNERSHIP_MISMATCH" });
  });

  it("warns when partial store injection is detected (Finding 2)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const auditStore = new FakeAuditStore();
    const runtime = createFakeRuntime();

    const agent = await createSeepient({
      auditStore,
      runtime,
      cwd: workspaceA,
      model: "mock-model",
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Partial state store injection detected"),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Missing: [policyStore, capabilityLedger]"),
    );

    warnSpy.mockRestore();
    await agent.close();
  });
});
