/**
 * Headless Zero-Write Gate (Spec 021, US2, QS-2).
 *
 * Verifies the core statelessness claim (FR-008, M8):
 * When all tenant state stores (auditStore, policyStore, capabilityLedger,
 * persistence, runtime) are injected into createAgent, generateText, or streamText:
 * ZERO files or directories are created or modified outside the workspace
 * (specifically within HOME or SEEPIENT_SECURITY_DIR).
 *
 * Blind spot note (FR-008 & Spec 021 review):
 * This test pins HOME and SEEPIENT_SECURITY_DIR to clean temp directories and
 * takes recursive before/after directory snapshots. Writes to hardcoded absolute
 * paths outside these pinned roots (e.g. /tmp directly, /etc, or root) would not
 * be detected by the directory snapshot alone.
 *
 * Provider runtime note:
 * Discovery caching and catalog enrichment in ProviderRuntime are strictly in-memory.
 * Provider audit logs only write on account management mutations, which chat workers
 * never execute. The test suite verifies both fake test doubles and actual ProviderRuntime
 * instances backed by in-memory stores (ProviderConfigStore(":memory:") and MemoryCredentialStore).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, realpathSync, readdirSync, statSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgent,
  generateText,
  streamText,
} from "../index.js";
import {
  FakeAuditStore,
  FakePolicyStore,
  FakeCapabilityLedger,
  RecordingPersistenceBackend,
  createFakeRuntime,
} from "./helpers/fake-stores.js";
import { ProviderConfigStore } from "../../../domain/providers/config-store/provider-config-store.js";
import { MemoryCredentialStore } from "../../../domain/providers/credentials/memory-credential-store.js";
import { ProviderRuntime } from "../../../domain/providers/provider-runtime.js";

function snapshotDir(root: string): Map<string, { size: number; mtimeMs: number }> {
  const map = new Map<string, { size: number; mtimeMs: number }>();
  if (!existsSync(root)) return map;

  function walk(current: string, relative: string) {
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(current, entry.name);
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const stat = statSync(full);
      map.set(rel, { size: stat.size, mtimeMs: stat.mtimeMs });
      if (entry.isDirectory()) {
        walk(full, rel);
      }
    }
  }

  walk(root, "");
  return map;
}

function diffSnapshots(
  before: Map<string, { size: number; mtimeMs: number }>,
  after: Map<string, { size: number; mtimeMs: number }>,
): string[] {
  const diffs: string[] = [];
  for (const [path, info] of after.entries()) {
    const prev = before.get(path);
    if (!prev) {
      diffs.push(`CREATED: ${path}`);
    } else if (prev.size !== info.size || prev.mtimeMs !== info.mtimeMs) {
      diffs.push(`MODIFIED: ${path}`);
    }
  }
  return diffs;
}

describe("QS-2: Headless Zero-Write Gate (FR-008)", () => {
  let homeDir: string;
  let secDir: string;
  let workspaceDir: string;
  let oldHome: string | undefined;
  let oldSecDir: string | undefined;

  beforeEach(() => {
    homeDir = realpathSync(mkdtempSync(join(tmpdir(), "seepient-zero-write-home-")));
    secDir = realpathSync(mkdtempSync(join(tmpdir(), "seepient-zero-write-sec-")));
    workspaceDir = realpathSync(mkdtempSync(join(tmpdir(), "seepient-zero-write-ws-")));

    // Setup skill in workspace
    const skillDir = join(workspaceDir, ".seepient", "skills", "test-ops");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---
name: test-ops
description: Test skill
---
# Test Ops
Instructions.
`,
      "utf8",
    );

    oldHome = process.env.HOME;
    oldSecDir = process.env.SEEPIENT_SECURITY_DIR;

    process.env.HOME = homeDir;
    process.env.SEEPIENT_SECURITY_DIR = secDir;
  });

  afterEach(() => {
    if (oldHome !== undefined) process.env.HOME = oldHome;
    else delete process.env.HOME;
    if (oldSecDir !== undefined) process.env.SEEPIENT_SECURITY_DIR = oldSecDir;
    else delete process.env.SEEPIENT_SECURITY_DIR;

    rmSync(homeDir, { recursive: true, force: true });
    rmSync(secDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("zero files/dirs created outside workspace during createAgent with all stores injected", async () => {
    const homeBefore = snapshotDir(homeDir);
    const secBefore = snapshotDir(secDir);

    const auditStore = new FakeAuditStore();
    const policyStore = new FakePolicyStore();
    const capabilityLedger = new FakeCapabilityLedger();
    const persistence = new RecordingPersistenceBackend();
    const runtime = createFakeRuntime({
      responses: [
        {
          toolCalls: [
            {
              id: "call-1",
              name: "write_file",
              args: { path: join(workspaceDir, "output.txt"), content: "hello world" },
            },
          ],
        },
        { content: "Wrote file to workspace." },
        {
          toolCalls: [
            {
              id: "call-2",
              name: "use_skill",
              args: { skill_name: "test-ops" },
            },
          ],
        },
        { content: "Used skill test-ops." },
      ],
    });

    const agent = await createAgent({
      principalId: "worker-principal",
      sessionId: "worker-session-1",
      cwd: workspaceDir,
      runtime,
      auditStore,
      policyStore,
      capabilityLedger,
      persist: persistence,
      consentMode: "autonomous",
      model: "mock-model",
    });

    const res1 = await agent.chat("Write file");
    expect(res1.text).toContain("Wrote file");

    const res2 = await agent.chat("Use skill");
    expect(res2.text).toContain("Used skill");

    const flushed = await agent.flushAudit();
    expect(flushed).toBe(0);

    await agent.close();

    // Verify stores received state in memory
    expect(auditStore.appends.length).toBeGreaterThan(0);
    expect(persistence.saves.length).toBeGreaterThan(0);

    // Verify ZERO writes outside workspace
    const homeAfter = snapshotDir(homeDir);
    const secAfter = snapshotDir(secDir);

    const homeDiffs = diffSnapshots(homeBefore, homeAfter);
    const secDiffs = diffSnapshots(secBefore, secAfter);

    expect(homeDiffs).toEqual([]);
    expect(secDiffs).toEqual([]);
  });

  it("zero files/dirs created outside workspace during generateText and streamText with all stores injected", async () => {
    const homeBefore = snapshotDir(homeDir);
    const secBefore = snapshotDir(secDir);

    const auditStore = new FakeAuditStore();
    const policyStore = new FakePolicyStore();
    const capabilityLedger = new FakeCapabilityLedger();
    const runtime = createFakeRuntime({
      responses: [
        {
          toolCalls: [
            {
              id: "call-g1",
              name: "get_current_datetime",
              args: {},
            },
          ],
        },
        { content: "Current time fetched." },
        {
          toolCalls: [
            {
              id: "call-s1",
              name: "get_current_datetime",
              args: {},
            },
          ],
        },
        { content: "Current time streamed." },
      ],
    });

    const genRes = await generateText("What time is it?", {
      principalId: "worker-principal",
      cwd: workspaceDir,
      runtime,
      auditStore,
      policyStore,
      capabilityLedger,
      model: "mock-model",
    });
    expect(genRes.text).toContain("Current time fetched");

    const streamRes = await streamText("Stream time", {
      principalId: "worker-principal",
      cwd: workspaceDir,
      runtime,
      auditStore,
      policyStore,
      capabilityLedger,
      model: "mock-model",
    });
    const streamedText = await streamRes.fullText;
    expect(streamedText).toContain("Current time streamed");

    // Verify ZERO writes outside workspace
    const homeAfter = snapshotDir(homeDir);
    const secAfter = snapshotDir(secDir);

    const homeDiffs = diffSnapshots(homeBefore, homeAfter);
    const secDiffs = diffSnapshots(secBefore, secAfter);

    expect(homeDiffs).toEqual([]);
    expect(secDiffs).toEqual([]);
  });

  it("zero files/dirs created outside workspace during createAgent with a real ProviderRuntime instance", async () => {
    const homeBefore = snapshotDir(homeDir);
    const secBefore = snapshotDir(secDir);

    const auditStore = new FakeAuditStore();
    const policyStore = new FakePolicyStore();
    const capabilityLedger = new FakeCapabilityLedger();
    const persistence = new RecordingPersistenceBackend();

    const configStore = new ProviderConfigStore(":memory:");
    const credentialStore = new MemoryCredentialStore();
    const runtime = createFakeRuntime({
      configStore,
      credentialStore,
      responses: [
        {
          toolCalls: [
            {
              id: "call-real-1",
              name: "write_file",
              args: { path: join(workspaceDir, "runtime-proof.txt"), content: "real runtime proof" },
            },
          ],
        },
        { content: "Wrote file via real ProviderRuntime." },
      ],
    });

    expect(runtime instanceof ProviderRuntime).toBe(true);

    const agent = await createAgent({
      principalId: "worker-principal",
      sessionId: "worker-session-real-rt",
      cwd: workspaceDir,
      runtime,
      auditStore,
      policyStore,
      capabilityLedger,
      persist: persistence,
      consentMode: "autonomous",
      model: "mock-model",
    });

    const res = await agent.chat("Write file with real runtime");
    expect(res.text).toContain("Wrote file via real ProviderRuntime");

    await agent.close();

    // Verify ZERO writes outside workspace
    const homeAfter = snapshotDir(homeDir);
    const secAfter = snapshotDir(secDir);

    const homeDiffs = diffSnapshots(homeBefore, homeAfter);
    const secDiffs = diffSnapshots(secBefore, secAfter);

    expect(homeDiffs).toEqual([]);
    expect(secDiffs).toEqual([]);
  });
});
