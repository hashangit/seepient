/**
 * P3 /permissions protected-policy command test (spec 008, T307, QS-3.3).
 *
 * Verifies: propose is inert, approve writes protected policy via CAS and
 * bumps the version, revoke-cap removes by index, status reports both legacy
 * and protected state. All mutations route through PolicyStore.compareAndSet.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { permissionsHandler } from "../permissions.js";
import { Agent } from "../../agent.js";
import { LocalPolicyStore, computeWorkspaceId, GLOBAL_WORKSPACE_ID } from "../../../../domain/permissions/policy-store.js";
import { createSnapshotStore } from "../../../../foundations/hashline/snapshot-store.js";
import { createMockRuntime } from "../../../../domain/__tests__/test-doubles.js";
import { SettingsManager } from "../../../../domain/settings/settings-manager.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seepient-perms-cmd-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Minimal agent stub exposing the policy-store accessors the handler needs. */
function makeAgent(): Agent {
  const fakeRuntime = createMockRuntime([{ content: "" }]);
  const agent = new Agent(
    fakeRuntime,
    "model",
    { snapshotStore: createSnapshotStore() },
    "system prompt",
    null,
    "openai",
  );
  const store = new LocalPolicyStore({ root: dir });
  agent.setPolicyStore(store, computeWorkspaceId("/proj"));
  return agent;
}

async function run(agent: Agent, args: string) {
  return permissionsHandler({ agent, args, config: {} });
}

describe("/permissions protected-policy (T307, QS-3.3)", () => {
  it("bare command shows concise permissions by user scope without internal capability vocabulary", async () => {
    const agent = makeAgent();
    const projectCap = {
      kind: "process" as const,
      executable: "/bin/sh",
      argvPrefix: ["-c", "echo hello"],
      argvExact: true,
    };
    const sessionCap = {
      kind: "process" as const,
      executable: "/bin/sh",
      argvPrefix: ["-c", "echo hi"],
      argvExact: true,
    };
    const store = agent.getPolicyStore()!;
    await store.compareAndSet(
      computeWorkspaceId("/proj"),
      0,
      { version: 1, capabilities: [projectCap] },
      { kind: "human", authorityId: "inline-approval", authenticatedBy: "tui" },
    );
    vi.spyOn(agent, "getActiveCapabilities").mockReturnValue([sessionCap]);

    const res = await run(agent, "");
    expect(res.output).toContain("Permissions");
    expect(res.output).toContain("This session");
    expect(res.output).toContain("This project");
    expect(res.output).toContain("Every project");
    expect(res.output).toContain("Run `echo hello`");
    expect(res.output).toContain("Run `echo hi`");
    expect(res.output).toContain("/permissions revoke project 1");
    expect(res.output).not.toContain("process:/bin/sh");
    expect(res.output).not.toContain("model-egress");
    expect(res.output).not.toContain("spec 008");
    expect(res.output).not.toContain("Protected policy");
  });

  it("autonomous mode requires an explicit warning confirmation before enabling", async () => {
    const agent = makeAgent();
    const set = vi.spyOn(SettingsManager.prototype, "setConfirmedAutonomousMode").mockResolvedValue();
    vi.spyOn(agent, "isPermissionPipelineEnabled").mockReturnValue(true);
    const apply = vi.spyOn(agent, "setAutonomousMode").mockImplementation(() => {});

    const warning = await run(agent, "autonomous on");
    expect(warning.output).toContain("WARNING");
    expect(warning.output).toContain("autonomous on --confirm");
    expect(set).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();

    const enabled = await run(agent, "autonomous on --confirm");
    expect(set).toHaveBeenCalledWith(true);
    expect(apply).toHaveBeenCalledWith(true);
    expect(enabled.output).toContain("Autonomous mode is ON");
    set.mockRestore();
  });

  it("status lists read-root and model-egress for revocation (review round 9)", async () => {
    const agent = makeAgent();
    const store = agent.getPolicyStore()!;
    await store.compareAndSet(
      computeWorkspaceId("/proj"),
      0,
      {
        version: 1,
        capabilities: [
          { kind: "read-root", root: "/proj" },
          { kind: "model-egress", providerClass: "anthropic", dataClasses: ["normal"] },
          { kind: "process", executable: "/bin/sh", argvPrefix: ["-c", "echo hi"], argvExact: true },
        ],
      },
      { kind: "human", authorityId: "inline-approval", authenticatedBy: "tui" },
    );
    const res = await run(agent, "");
    expect(res.output).toContain("Read files in");
    expect(res.output).toContain("Share tool results with the AI provider");
    // Numbering covers every persisted capability, model-egress included.
    expect(res.output).toContain("/permissions revoke project 2");
    const revoked = await run(agent, "revoke project 2");
    expect(revoked.output).toContain("Removed project permission");
    const after = await store.read(computeWorkspaceId("/proj"));
    expect(after.policy.capabilities).toEqual([
      { kind: "read-root", root: "/proj" },
      { kind: "process", executable: "/bin/sh", argvPrefix: ["-c", "echo hi"], argvExact: true },
    ]);
  });

  it("human revoke command maps its one-based project number to the stored capability", async () => {
    const agent = makeAgent();
    const store = agent.getPolicyStore()!;
    await store.compareAndSet(
      computeWorkspaceId("/proj"),
      0,
      {
        version: 1,
        capabilities: [
          { kind: "process", executable: "/bin/sh", argvPrefix: ["-c", "echo hello"], argvExact: true },
          { kind: "write-root", root: "/proj" },
        ],
      },
      { kind: "human", authorityId: "inline-approval", authenticatedBy: "tui" },
    );
    // Review round 10: revoke numbers address the last rendered list.
    await run(agent, "");
    const revoked = await run(agent, "revoke project 1");
    expect(revoked.output).toContain("Removed project permission");
    const after = await store.read(computeWorkspaceId("/proj"));
    expect(after.policy.capabilities).toEqual([{ kind: "write-root", root: "/proj" }]);
  });

  it("human revoke command removes a current-session permission immediately", async () => {
    const agent = makeAgent();
    const sessionCap = {
      kind: "process" as const,
      executable: "/bin/sh",
      argvPrefix: ["-c", "echo hi"],
      argvExact: true,
    };
    vi.spyOn(agent, "getActiveCapabilities").mockReturnValue([sessionCap]);
    const revoke = vi.spyOn(agent, "revokeSessionCapability").mockImplementation(() => {});

    await run(agent, "");
    const result = await run(agent, "revoke session 1");
    expect(revoke).toHaveBeenCalledWith(sessionCap);
    expect(result.output).toContain("Removed session permission");
  });

  it("revoke without a prior /permissions render is rejected (review round 10)", async () => {
    const agent = makeAgent();
    const sessionCap = {
      kind: "process" as const,
      executable: "/bin/sh",
      argvPrefix: ["-c", "echo hi"],
      argvExact: true,
    };
    vi.spyOn(agent, "getActiveCapabilities").mockReturnValue([sessionCap]);
    const revoke = vi.spyOn(agent, "revokeSessionCapability").mockImplementation(() => {});

    const result = await run(agent, "revoke session 1");
    expect(result.output).toContain("Run /permissions first");
    expect(revoke).not.toHaveBeenCalled();
  });

  it("revoke rejects when the list changed since the render (review round 10)", async () => {
    const agent = makeAgent();
    const capA = {
      kind: "process" as const,
      executable: "/bin/sh",
      argvPrefix: ["-c", "echo a"],
      argvExact: true,
    };
    const capB = {
      kind: "process" as const,
      executable: "/bin/sh",
      argvPrefix: ["-c", "echo b"],
      argvExact: true,
    };
    const active = vi.spyOn(agent, "getActiveCapabilities").mockReturnValue([capA]);
    const revoke = vi.spyOn(agent, "revokeSessionCapability").mockImplementation(() => {});

    await run(agent, ""); // renders [capA]
    active.mockReturnValue([capA, capB]); // a later approval shifted the list
    const rejected = await run(agent, "revoke session 1");
    expect(rejected.output).toContain("changed since it was shown");
    expect(revoke).not.toHaveBeenCalled();

    // Re-rendering addresses the new list.
    await run(agent, "");
    const ok = await run(agent, "revoke session 2");
    expect(ok.output).toContain("Removed session permission");
    expect(revoke).toHaveBeenCalledWith(capB);
  });

  it("propose is inert — does not write active policy", async () => {
    const agent = makeAgent();
    const res = await run(agent, "propose commit-file:/proj/a.txt");
    expect(res.output).toContain("Staged proposal");
    expect(res.output).toContain("Inactive");

    const snap = await agent.getPolicyStore()!.read(computeWorkspaceId("/proj"));
    expect(snap.version).toBe(0); // unchanged
    expect(snap.policy.capabilities).toHaveLength(0);
  });

  it("review lists pending proposals", async () => {
    const agent = makeAgent();
    await run(agent, "propose commit-file:/proj/a.txt");
    await run(agent, "propose read-root:/proj");
    const res = await run(agent, "review");
    expect(res.output).toContain("commit-file:/proj/a.txt");
    expect(res.output).toContain("read-root:/proj");
  });

  it("approve writes active policy via CAS and bumps version", async () => {
    const agent = makeAgent();
    await run(agent, "propose commit-file:/proj/a.txt");
    const review = await run(agent, "review");
    const id = (review.output!.match(/\b[a-f0-9]{8}\b/g) ?? [])[0];
    expect(id).toBeDefined();

    const res = await run(agent, `approve ${id}`);
    expect(res.output).toContain("version 1");

    const snap = await agent.getPolicyStore()!.read(computeWorkspaceId("/proj"));
    expect(snap.version).toBe(1);
    expect(snap.policy.capabilities).toEqual([{ kind: "commit-file", path: "/proj/a.txt" }]);
  });

  it("revoke-cap removes the capability by index", async () => {
    const agent = makeAgent();
    await run(agent, "propose commit-file:/proj/a.txt");
    const review = await run(agent, "review");
    const id = (review.output!.match(/\b[a-f0-9]{8}\b/g) ?? [])[0];
    await run(agent, `approve ${id}`);

    const res = await run(agent, "revoke-cap 0");
    expect(res.output).toContain("Revoked");

    const snap = await agent.getPolicyStore()!.read(computeWorkspaceId("/proj"));
    expect(snap.policy.capabilities).toHaveLength(0);
    expect(snap.version).toBe(2);
  });

  it("diagnostics retains the detailed support view", async () => {
    const agent = makeAgent();
    const res = await run(agent, "diagnostics");
    expect(res.output).toContain("Legacy grants");
    expect(res.output).toContain("Protected policy");
    expect(res.output).toContain("configured");
    // Spec 011: the status also shows active session authority (empty here
    // because no session approval happened) and the containment backend.
    expect(res.output).toContain("Active session authority");
    expect(res.output).toContain("Containment");
  });

  it("status lists global policy and revoke-global removes it (spec 011 persistent choices)", async () => {
    const agent = makeAgent();
    const store = agent.getPolicyStore()!;
    // Simulate an "Allow always" grant written by the inline approval path.
    const current = await store.read(GLOBAL_WORKSPACE_ID);
    await store.compareAndSet(
      GLOBAL_WORKSPACE_ID,
      current.version,
      { version: 1, capabilities: [{ kind: "commit-file", path: "/proj/a.txt" }] },
      { kind: "human", authorityId: "inline-approval", authenticatedBy: "tui" },
    );
    const status = await run(agent, "status");
    expect(status.output).toContain("Every project");
    expect(status.output).toContain("/permissions revoke always 1");

    const revoked = await run(agent, "revoke-global 0");
    expect(revoked.output).toContain("Revoked GLOBAL capability");
    const after = await store.read(GLOBAL_WORKSPACE_ID);
    expect(after.policy.capabilities).toHaveLength(0);
  });

  it("invalid capability kind is rejected at propose", async () => {
    const agent = makeAgent();
    const res = await run(agent, "propose bogus:/x");
    expect(res.output).toContain("Unsupported capability kind");
  });

  it("approve of unknown id fails gracefully", async () => {
    const agent = makeAgent();
    const res = await run(agent, "approve no-such-id");
    expect(res.output).toContain("No proposal");
  });
});
