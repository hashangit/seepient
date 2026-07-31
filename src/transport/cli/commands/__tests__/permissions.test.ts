/**
 * P3 /permissions protected-policy command test (spec 008, T307, QS-3.3).
 *
 * Verifies: propose is inert, approve writes protected policy via CAS and
 * bumps the version, revoke-cap removes by index, status reports both legacy
 * and protected state. All mutations route through PolicyStore.compareAndSet.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { permissionsHandler } from "../permissions.js";
import { Agent } from "../../agent.js";
import { LocalPolicyStore, computeWorkspaceId } from "../../../../domain/permissions/policy-store.js";
import { createSnapshotStore } from "../../../../foundations/hashline/snapshot-store.js";
import type { LLMProvider } from "../../../../foundations/contracts/llm.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seepient-perms-cmd-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Minimal agent stub exposing the policy-store accessors the handler needs. */
function makeAgent(): Agent {
  const fakeProvider: LLMProvider = {
    async chat() {
      return { content: "", tool_calls: [] };
    },
  };
  const agent = new Agent(
    fakeProvider,
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

  it("status reports both legacy and protected state", async () => {
    const agent = makeAgent();
    const res = await run(agent, "status");
    expect(res.output).toContain("Legacy grants");
    expect(res.output).toContain("Protected policy");
    expect(res.output).toContain("configured");
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
