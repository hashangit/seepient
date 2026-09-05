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
} from "../src/worker.js";
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

    // Verify session persistence in stub control plane app
    expect(stubApp.state.sessions.has("session-xyz")).toBe(true);

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
    const offlinePolicyStore = new RemotePolicyStore("http://127.0.0.1:1");
    await expect(offlinePolicyStore.read("default")).rejects.toThrow(/Policy read failed/);
  });
});
