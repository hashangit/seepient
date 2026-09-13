/**
 * Reference Worker End-to-End Test (Spec 021, FR-011, QS-4).
 *
 * Verifies:
 * 1. Worker agent runs against stub embedder app with HTTP-backed store adapters.
 * 2. Brokered tool + permission-gated tool with approval relay execute.
 * 3. Audit, policy, capability, and session states land in the stub app.
 * 4. Zero persistent state on worker HOME / security dir.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorkerAgent,
  RemotePolicyStore,
  RemoteAuditStore,
  RemoteCapabilityLedger,
  DbSkillSource,
} from "../src/worker.js";
import { FsSkillSources } from "../../../src/transport/sdk/index.js";
import { createStubApp } from "../src/stub-app.js";
import { createFakeRuntime } from "../../../src/transport/sdk/__tests__/helpers/fake-stores.js";
import { diskBackedFakeHelper } from "../../../src/capabilities/execution/__tests__/helpers/commit-helper-fakes.js";

describe("QS-4: Reference Worker End-to-End", () => {
  let homeDir: string;
  let secDir: string;
  let workspaceDir: string;
  let oldHome: string | undefined;
  let oldSecDir: string | undefined;

  let stubApp: ReturnType<typeof createStubApp>;
  let controlPlanePort: number;

  beforeEach(async () => {
    homeDir = realpathSync(mkdtempSync(join(tmpdir(), "seepient-worker-home-")));
    secDir = realpathSync(mkdtempSync(join(tmpdir(), "seepient-worker-sec-")));
    workspaceDir = realpathSync(mkdtempSync(join(tmpdir(), "seepient-worker-ws-")));

    oldHome = process.env.HOME;
    oldSecDir = process.env.SEEPIENT_SECURITY_DIR;

    process.env.HOME = homeDir;
    process.env.SEEPIENT_SECURITY_DIR = secDir;

    stubApp = createStubApp();
    stubApp.state.tokenToPrincipal.set("token-user-123", "user-123");
    stubApp.state.tokenToPrincipal.set("token-global", "default");
    stubApp.state.tokenToPrincipal.set("token-tenant-abc", "tenant-abc");
    stubApp.state.tokenToPrincipal.set("token-tenant-a", "tenant-a");
    stubApp.state.tokenToPrincipal.set("token-tenant-b", "tenant-b");
    controlPlanePort = await stubApp.listen();
  });

  afterEach(async () => {
    if (oldHome !== undefined) process.env.HOME = oldHome;
    else delete process.env.HOME;
    if (oldSecDir !== undefined) process.env.SEEPIENT_SECURITY_DIR = oldSecDir;
    else delete process.env.SEEPIENT_SECURITY_DIR;

    await stubApp.close();

    rmSync(homeDir, { recursive: true, force: true });
    rmSync(secDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("completes full conversation with audit forwarding, approval relay, and session persistence", async () => {
    const runtime = createFakeRuntime({
      responses: [
        {
          toolCalls: [
            {
              id: "call-1",
              name: "get_current_datetime",
              args: {},
            },
          ],
        },
        {
          toolCalls: [
            {
              id: "call-2",
              name: "write_file",
              args: { path: join(workspaceDir, "summary.txt"), content: "Meeting Summary" },
            },
          ],
        },
        { content: "Summary written to disk." },
      ],
    });

    const workerAgent = await createWorkerAgent({
      tenantId: "tenant-abc",
      principalId: "user-123",
      sessionId: "session-xyz",
      workspaceDir,
      runtime,
      controlPlaneUrl: `http://127.0.0.1:${controlPlanePort}`,
      controlPlaneToken: "token-user-123",
      consentMode: "ask-everything",
      commitHelper: diskBackedFakeHelper(),
    });

    const response = await workerAgent.chat("Get time and write summary");
    expect(response.text).toContain("Summary written to disk");

    await workerAgent.close();

    // Verify approval relay was triggered in the stub control plane app
    expect(stubApp.state.approvalRequests.length).toBeGreaterThan(0);
    expect(stubApp.state.approvalRequests[0].action.title).toBe("Write summary.txt");
    expect(stubApp.state.approvalRequests[0].action.canonicalTargets[0]).toContain("summary.txt");

    // Verify audit events arrived at the stub control plane app
    expect(stubApp.state.auditEvents.length).toBeGreaterThan(0);
    expect(stubApp.state.auditEvents[0].event.principalId).toBe("user-123");

    // Verify session persistence in stub control plane app (keyed by principal:sessionId)
    expect(stubApp.state.sessions.has("user-123:session-xyz")).toBe(true);

    // Verify capability consumption recorded
    expect(stubApp.state.consumedDigests.size).toBeGreaterThan(0);

    // Verify file written in workspace
    expect(existsSync(join(workspaceDir, "summary.txt"))).toBe(true);

    // Verify no seepient security dir in HOME
    expect(existsSync(join(homeDir, ".seepient"))).toBe(false);
  });

  it("throws fail-closed when controlPlaneUrl is missing (F5)", async () => {
    const runtime = createFakeRuntime({ responses: [{ content: "hi" }] });
    await expect(
      createWorkerAgent({
        tenantId: "t1",
        principalId: "p1",
        sessionId: "s1",
        workspaceDir,
        runtime,
        controlPlaneUrl: "",
      }),
    ).rejects.toThrow(/controlPlaneUrl is required/);
  });

  it("remote stores require controlPlaneUrl and fail closed without fallback", async () => {
    expect(() => new RemotePolicyStore("")).toThrow(/controlPlaneUrl is required/);
    expect(() => new RemoteAuditStore("")).toThrow(/controlPlaneUrl is required/);
    expect(() => new RemoteCapabilityLedger("")).toThrow(/controlPlaneUrl is required/);

    // With unreachable controlPlaneUrl, policy read fails closed with error
    const offlinePolicyStore = new RemotePolicyStore("http://127.0.0.1:1", { controlPlaneToken: "offline-token" });
    await expect(offlinePolicyStore.read("default")).rejects.toThrow(/Policy read failed/);
  });

  it("QS-S3: DbSkillSource composes [fs, global, tenant] with tenant-specific shadowing", async () => {
    // 1. Seed global and tenant skills in stub control plane
    stubApp.state.skills.push(
      {
        id: "s-global-summarize",
        name: "summarize",
        content: "---\nname: summarize\ndescription: Global summarize procedure\n---\nGlobal body",
        tenant_id: null,
        source: "db:global",
      },
      {
        id: "s-tenant-summarize",
        name: "summarize",
        content: "---\nname: summarize\ndescription: Tenant-specific summarize procedure\n---\nTenant body",
        tenant_id: "tenant-abc",
        source: "db:tenant:tenant-abc",
      },
      {
        id: "s-global-health",
        name: "health-check",
        content: "---\nname: health-check\ndescription: Global health check\n---\nHealth check body",
        tenant_id: null,
        source: "db:global",
      },
    );

    const globalSource = new DbSkillSource(`http://127.0.0.1:${controlPlanePort}`, { controlPlaneToken: "token-global" });
    const tenantSource = new DbSkillSource(`http://127.0.0.1:${controlPlanePort}`, { tenantId: "tenant-abc", controlPlaneToken: "token-tenant-abc" });

    let stepCount = 0;
    const runtime = createFakeRuntime({
      responses: () => {
        stepCount++;
        if (stepCount === 1) {
          return {
            toolCalls: [
              {
                id: "call-skill-1",
                name: "use_skill",
                arguments: { skill_name: "summarize" },
              },
            ],
          };
        }
        return { text: "Summarize finished." };
      },
    });

    const workerAgent = await createWorkerAgent({
      tenantId: "tenant-abc",
      principalId: "user-123",
      sessionId: "session-skills",
      workspaceDir,
      runtime,
      controlPlaneUrl: `http://127.0.0.1:${controlPlanePort}`,
      controlPlaneToken: "token-user-123",
      consentMode: "ask-everything",
      commitHelper: diskBackedFakeHelper(),
      sources: [new FsSkillSources(workspaceDir), globalSource, tenantSource],
    });

    // Verify system prompt catalog composition:
    // Tenant-specific "summarize" must shadow the global "summarize"
    const history = workerAgent.getHistory();
    const sysMsg: any = history.find((m: any) => m.role === "system");
    const sysText =
      typeof sysMsg?.content === "string"
        ? sysMsg.content
        : Array.isArray(sysMsg?.content)
          ? sysMsg.content.map((c: any) => c.text ?? "").join("\n")
          : "";

    expect(sysText).toContain("summarize: Tenant-specific summarize procedure");
    expect(sysText).not.toContain("Global summarize procedure");
    expect(sysText).toContain("health-check: Global health check");

    // Execute skill call
    const response = await workerAgent.chat("Please summarize");
    expect(response.toolCalls.length).toBe(1);

    const toolMsg = workerAgent.getHistory().find((m: any) => m.role === "tool");
    expect(toolMsg?.content).toContain("# summarize Skill Activated");
    expect(toolMsg?.content).toContain("Tenant body");

    await workerAgent.close();
  });

  it("FR-023: Tenant A's policy grant is invisible to Tenant B on a shared workspace", async () => {
    const policyStore = new RemotePolicyStore(`http://127.0.0.1:${controlPlanePort}`, {
      controlPlaneToken: "token-tenant-a",
      principalId: "tenant-a",
    });
    const workspaceId = "shared-workspace-test";

    // Compare and set grant for Tenant A
    await policyStore.compareAndSet(
      workspaceId,
      0,
      {
        version: 1,
        capabilities: [
          { kind: "write-root", root: "/data/tenant-a", principalId: "tenant-a" },
        ],
      },
      { kind: "service", authorityId: "test", authenticatedBy: "system" },
    );

    // Read policy as Tenant A in multi-tenant mode
    const snapA = await policyStore.read(workspaceId, {
      principalId: "tenant-a",
      tenancyMode: "multi",
    });
    expect(snapA.policy.capabilities).toHaveLength(1);
    expect(snapA.policy.capabilities[0].principalId).toBe("tenant-a");

    // Read policy as Tenant B on the same shared workspace in multi-tenant mode
    const snapB = await policyStore.read(workspaceId, {
      principalId: "tenant-b",
      tenancyMode: "multi",
      controlPlaneToken: "token-tenant-b",
    });
    // Tenant B must not see Tenant A's capability grant
    expect(snapB.policy.capabilities.some((c) => c.principalId === "tenant-a")).toBe(false);
    expect(snapB.policy.capabilities).toHaveLength(0);

    // Also verify when a shared workspace has policies for both principals
    stubApp.state.policySnapshots.set("shared-workspace-both", {
      workspaceId: "shared-workspace-both",
      version: 1,
      policyDigest: "digest-both",
      policy: {
        version: 1,
        capabilities: [
          { kind: "write-root", root: "/data/tenant-a", principalId: "tenant-a" },
          { kind: "write-root", root: "/data/tenant-b", principalId: "tenant-b" },
        ],
      },
      mutationHistory: [],
    });

    const readB = await policyStore.read("shared-workspace-both", {
      principalId: "tenant-b",
      tenancyMode: "multi",
      controlPlaneToken: "token-tenant-b",
    });
    expect(readB.policy.capabilities).toHaveLength(1);
    expect(readB.policy.capabilities[0].principalId).toBe("tenant-b");
    expect(readB.policy.capabilities.some((c) => c.principalId === "tenant-a")).toBe(false);

    const readA = await policyStore.read("shared-workspace-both", {
      principalId: "tenant-a",
      tenancyMode: "multi",
    });
    expect(readA.policy.capabilities).toHaveLength(1);
    expect(readA.policy.capabilities[0].principalId).toBe("tenant-a");
    expect(readA.policy.capabilities.some((c) => c.principalId === "tenant-b")).toBe(false);
  });
});

