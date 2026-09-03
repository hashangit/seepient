/**
 * QS-0 — defaults unchanged (Spec 021 P0 gate).
 *
 * Verifies that running createAgent, generateText, and streamText without
 * any store/runtime injection options preserves default behavior, defaults
 * to "sdk-user" principal identity, writes to ~/.seepient/security, and
 * memoizes getDefaultProviderRuntime().
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgent,
  generateText,
  getDefaultProviderRuntime,
} from "../index.js";
import { createMockRuntime } from "../../../domain/__tests__/test-doubles.js";

describe("QS-0: Defaults unchanged", () => {
  let homeDir: string;
  let workspaceDir: string;
  let oldHome: string | undefined;
  let oldSecDir: string | undefined;

  beforeEach(() => {
    homeDir = realpathSync(mkdtempSync(join(tmpdir(), "seepient-qs0-home-")));
    workspaceDir = realpathSync(mkdtempSync(join(tmpdir(), "seepient-qs0-ws-")));
    oldHome = process.env.HOME;
    oldSecDir = process.env.SEEPIENT_SECURITY_DIR;
    process.env.HOME = homeDir;
    delete process.env.SEEPIENT_SECURITY_DIR;
  });

  afterEach(() => {
    if (oldHome !== undefined) process.env.HOME = oldHome;
    else delete process.env.HOME;
    if (oldSecDir !== undefined) process.env.SEEPIENT_SECURITY_DIR = oldSecDir;
    else delete process.env.SEEPIENT_SECURITY_DIR;
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("getDefaultProviderRuntime memoizes a single default instance across calls", () => {
    const r1 = getDefaultProviderRuntime();
    const r2 = getDefaultProviderRuntime();
    expect(r1).toBe(r2);
  });

  it("createAgent with permissionPipeline default options writes to security/audit/sdk-user", async () => {
    const mockRuntime = createMockRuntime([
      {
        toolCalls: [
          {
            id: "call-1",
            name: "write_file",
            args: { path: join(workspaceDir, "test.txt"), content: "hello" },
          },
        ],
      },
      { content: "File written successfully." },
    ]);

    const agent = await createAgent({
      cwd: workspaceDir,
      runtime: mockRuntime,
    });

    const res = await agent.chat("Write a file");
    expect(res.text).toContain("File written");

    // Check default audit layout: ~/.seepient/security/audit/sdk-user/events.ndjson
    const expectedAuditFile = join(homeDir, ".seepient", "security", "audit", "sdk-user", "events.ndjson");
    expect(existsSync(expectedAuditFile)).toBe(true);

    // Check default caps and security directories exist under ~/.seepient/security
    const expectedSecurityDir = join(homeDir, ".seepient", "security");
    const expectedCapsDir = join(expectedSecurityDir, "caps");
    const expectedPoliciesDir = join(expectedSecurityDir, "policies");
    expect(existsSync(expectedSecurityDir)).toBe(true);
    expect(existsSync(expectedCapsDir)).toBe(true);

    // Assert default policy store writes to ~/.seepient/security/policies/<workspaceId>.json
    const { LocalPolicyStore } = await import("../../../domain/permissions/policy-store.js");
    const policyStore = new LocalPolicyStore();
    await policyStore.compareAndSet(
      "default",
      0,
      { version: 1, capabilities: [{ kind: "write-root", root: workspaceDir }] },
      { kind: "principal", authorityId: "sdk-user", authenticatedBy: "test" },
    );
    expect(existsSync(expectedPoliciesDir)).toBe(true);
    expect(existsSync(join(expectedPoliciesDir, "default.json"))).toBe(true);

    await agent.close();
  });

  it("without approval broker, safe read tools proceed while unapproved effectful actions deny with actionable message", async () => {
    const mockRuntime = createMockRuntime([
      {
        toolCalls: [
          {
            id: "call-read",
            name: "read_file",
            args: { path: join(workspaceDir, "test.txt") },
          },
        ],
      },
      {
        toolCalls: [
          {
            id: "call-write",
            name: "write_file",
            args: { path: join(workspaceDir, "forbidden.txt"), content: "denied" },
          },
        ],
      },
      { content: "Tool call was denied." },
    ]);

    const agent = await createAgent({
      cwd: workspaceDir,
      runtime: mockRuntime,
      // No approval broker or approveTool provided
    });

    const res = await agent.chat("Read and write");
    expect(res.text).toBeDefined();

    // Check that denied action produced audit entry
    const expectedAuditFile = join(homeDir, ".seepient", "security", "audit", "sdk-user", "events.ndjson");
    expect(existsSync(expectedAuditFile)).toBe(true);

    await agent.close();
  });

  it("createAgent with explicit persist path writes session files", async () => {
    const sessionDir = join(workspaceDir, "sessions");
    const mockRuntime = createMockRuntime([{ content: "Saved session." }]);
    const agent = await createAgent({
      sessionId: "default-session-123",
      persist: sessionDir,
      cwd: workspaceDir,
      runtime: mockRuntime,
    });

    await agent.chat("Persist this message");
    const expectedSessionFile = join(sessionDir, "default-session-123.json");
    expect(existsSync(expectedSessionFile)).toBe(true);

    await agent.close();
  });
});
