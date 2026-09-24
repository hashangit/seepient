import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  linkSync,
  realpathSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeReadFile, analyzeGenerateImage } from "../../../../capabilities/tools/analyzers.js";
import { ReadFileExecutor } from "../../../../capabilities/execution/executors.js";
import { InMemoryArtifactStore } from "../../../../capabilities/execution/in-memory-artifact-store.js";
import { PathEscapesWorkspaceError, PathHardlinkRefusedError } from "../../../../foundations/errors.js";
import type { ToolAnalysisContext } from "../../../../foundations/contracts/custom-tools.js";

describe("Symlink & Read-Plane Security Journeys (FR-002, FR-003, FR-004, FR-013, FR-014, T026, T027)", () => {
  let hostDir: string;
  let workspaceDir: string;
  let analysisCtx: ToolAnalysisContext;

  beforeEach(() => {
    hostDir = realpathSync(mkdtempSync(join(tmpdir(), "symlink-host-")));
    workspaceDir = realpathSync(mkdtempSync(join(tmpdir(), "symlink-workspace-")));

    analysisCtx = {
      principalId: "tenant-a",
      runId: "r-symlink",
      toolCallId: "c-symlink",
      workspace: {
        workspaceId: "ws-symlink-test",
        canonicalRoot: workspaceDir,
        policyVersion: 1,
        policyDigest: "test-digest",
      },
      artifacts: new InMemoryArtifactStore(),
      modelProviderClass: "openai",
    };
  });

  afterEach(() => {
    rmSync(hostDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("FR-002: ceiling-escaping symlink is denied with PATH_ESCAPES_WORKSPACE and remediation text", async () => {
    const hostSecret = join(hostDir, "host-secret.txt");
    writeFileSync(hostSecret, "SUPER-SECRET-HOST-DATA", "utf-8");

    const escapingLink = join(workspaceDir, "note.txt");
    symlinkSync(hostSecret, escapingLink);

    // analyzeReadFile must reject the ceiling escape with PATH_ESCAPES_WORKSPACE
    await expect(
      analyzeReadFile({ path: "note.txt" }, analysisCtx),
    ).rejects.toSatisfy((err: any) => {
      const isCode = err?.code === "PATH_ESCAPES_WORKSPACE";
      const hasMessage = err?.message?.includes("resolves outside your workspace");
      return isCode && hasMessage;
    });
  });

  it("FR-002 / T013: in-workspace final symlink is ALLOWED (tenant mental model: links inside sandbox are mine)", async () => {
    const realFile = join(workspaceDir, "v2.txt");
    writeFileSync(realFile, "IN-WORKSPACE-REAL-CONTENT", "utf-8");

    const inWorkspaceLink = join(workspaceDir, "current.txt");
    symlinkSync(realFile, inWorkspaceLink);

    // In-workspace symlink must NOT be rejected by static refusal.
    // It should resolve and authorize the realpath!
    const prepared = await analyzeReadFile({ path: "current.txt" }, analysisCtx);
    expect(prepared).toBeDefined();
    // The canonical path should be the real target (authorize-what-you-read)
    expect(prepared.operation.kind).toBe("read-file");
    if (prepared.operation.kind === "read-file") {
      expect(prepared.operation.target.canonicalPath).toBe(realFile);
    }

    // Execution must read the authorized content
    const executor = new ReadFileExecutor();
    const execRes = await executor.execute(prepared, { capabilities: [] } as any, prepared.operation as any, {});
    expect(execRes.state).toBe("succeeded");
    expect((execRes as any).result.output).toContain("IN-WORKSPACE-REAL-CONTENT");
  });

  it("T027 [US6]: hardlink read target with st_nlink > 1 is denied with PATH_HARDLINK_REFUSED", async () => {
    // A file created outside the workspace (or with multiple links)
    const hostTarget = join(hostDir, "host-file.txt");
    writeFileSync(hostTarget, "HOST-SHARED-INODE", "utf-8");

    const hardlinkInWs = join(workspaceDir, "hardlink.txt");
    try {
      linkSync(hostTarget, hardlinkInWs);
    } catch {
      // If cross-device hardlink is not permitted by OS, create two hardlinks inside workspace
      // to verify st_nlink > 1 is caught
      const wsTarget = join(workspaceDir, "ws-original.txt");
      writeFileSync(wsTarget, "LINKED-CONTENT", "utf-8");
      linkSync(wsTarget, hardlinkInWs);
    }

    const prepared = await analyzeReadFile({ path: "hardlink.txt" }, analysisCtx);

    const executor = new ReadFileExecutor();
    const execRes = await executor.execute(prepared, { capabilities: [] } as any, prepared.operation as any, {});

    // Must be failed with PATH_HARDLINK_REFUSED
    expect(execRes.state).toBe("failed");
    if (execRes.state === "failed") {
      expect(execRes.error.code).toBe("PATH_HARDLINK_REFUSED");
      expect(execRes.error.message).toContain("more than one name");
    }
  });

  it("FR-004 / T005: media input image resolves against workspaceRoot, never process.cwd()", async () => {
    const { generateImageRuntime } = await import("../../../../capabilities/media/media.js");

    const wsImage = join(workspaceDir, "victim.png");
    writeFileSync(wsImage, "WORKSPACE-IMAGE-BYTES", "utf-8");

    // No decoy is planted at process.cwd(): if media resolved the relative path
    // against cwd, the input read would fail ENOENT (nothing at <repo>/victim.png)
    // and this test would fail. Drive through the real analyzer so the input
    // carries the authorized absolute path + identity like production.
    const prepared = await analyzeGenerateImage(
      { prompt: "variation of this", image_path: "victim.png", mode: "variation" },
      analysisCtx,
    );
    const input = (prepared.operation as any).request.input;
    expect(input.imagePath).toBe(wsImage);
    expect(input.imageIdentity).toBeDefined();

    let capturedImageBytes: string | undefined;
    const mockRuntime = {
      async createTurnSnapshot() { return {}; },
      async resolvePlan() { return { model: "dall-e-3" }; },
      async executeImage(plan: any, req: any) {
        capturedImageBytes = req.inputImage?.data;
        return { images: [{ bytes: Buffer.from("out"), mimeType: "image/png" }] };
      },
    };

    await generateImageRuntime(input, mockRuntime as any, undefined, undefined, {
      tenancyMode: "multi",
      capabilities: [],
      workspaceRoot: workspaceDir,
    } as any);

    // Captured image data must be base64 of WORKSPACE-IMAGE-BYTES
    expect(capturedImageBytes).toBe(Buffer.from("WORKSPACE-IMAGE-BYTES").toString("base64"));
  });

  it("T026 [US6]: swap-racer cannot exfiltrate host secret between authorization and read", async () => {
    const hostSecret = join(hostDir, "host-secret.txt");
    writeFileSync(hostSecret, "SUPER-SECRET-HOST-DATA", "utf-8");

    const targetFile = join(workspaceDir, "racing-file.txt");
    writeFileSync(targetFile, "AUTHORIZED-SAFE-CONTENT", "utf-8");

    // 1. Authorize the read for racing-file.txt
    const prepared = await analyzeReadFile({ path: "racing-file.txt" }, analysisCtx);

    // 2. Race: background alternation swap flips targetFile to a symlink to hostSecret
    rmSync(targetFile);
    symlinkSync(hostSecret, targetFile);

    // 3. Execute: ReadFileExecutor MUST NOT return hostSecret bytes!
    // It must either fail closed (O_NOFOLLOW / identity mismatch) or return safe content.
    const executor = new ReadFileExecutor();
    const execRes = await executor.execute(prepared, { capabilities: [] } as any, prepared.operation as any, {});

    if (execRes.state === "succeeded") {
      expect((execRes as any).result.output).not.toContain("SUPER-SECRET-HOST-DATA");
    } else {
      expect(execRes.state).toBe("failed");
      if (execRes.state === "failed") {
        expect(["SYMLINK_READ_DENIED", "PATH_IDENTITY_MISMATCH"]).toContain(execRes.error.code);
      }
    }
  });

  it("P1-1 (pass-10): parent-directory symlink swap between authorization and execution is denied (PATH_IDENTITY_MISMATCH)", async () => {
    const hostSecretDir = join(hostDir, "ssh");
    mkdirSync(hostSecretDir);
    const hostSecret = join(hostSecretDir, "id_rsa");
    writeFileSync(hostSecret, "HOST-SECRET-KEY-MATERIAL", "utf-8");

    // In-workspace directory containing the file the tenant asks to read.
    const dirPath = join(workspaceDir, "dir");
    mkdirSync(dirPath);
    writeFileSync(join(dirPath, "id_rsa"), "tenant-decoy-bytes", "utf-8");

    // 1. Authorize the in-workspace read (realpath inside ceiling, sensitivity normal).
    const prepared = await analyzeReadFile({ path: "dir/id_rsa" }, analysisCtx);
    expect(prepared.operation.kind).toBe("read-file");

    // 2. Approval-window attack: move the real dir aside, replace the PARENT with a
    //    symlink to the host directory. O_NOFOLLOW only guards the final component,
    //    so only an authorization-time identity pin can catch this.
    rmSync(dirPath, { recursive: true });
    symlinkSync(hostSecretDir, dirPath);

    const executor = new ReadFileExecutor();
    const execRes = await executor.execute(prepared, { capabilities: [] } as any, prepared.operation as any, {});

    expect(execRes.state).toBe("failed");
    if (execRes.state === "failed") {
      expect(execRes.error.code).toBe("PATH_IDENTITY_MISMATCH");
    }
    expect(JSON.stringify(execRes)).not.toContain("HOST-SECRET-KEY-MATERIAL");
  });

  it("P1-1 media (pass-10): parent-dir swap on generate_image input never reaches the vendor", async () => {
    const { generateImageRuntime } = await import("../../../../capabilities/media/media.js");

    const hostSecretDir = join(hostDir, "img");
    mkdirSync(hostSecretDir);
    writeFileSync(join(hostSecretDir, "victim.png"), "HOST-IMAGE-BYTES", "utf-8");

    const dirPath = join(workspaceDir, "assets");
    mkdirSync(dirPath);
    writeFileSync(join(dirPath, "victim.png"), "WORKSPACE-IMAGE-BYTES", "utf-8");

    // Authorize through the real analyzer so identity is stamped like production.
    const prepared = await analyzeGenerateImage(
      { prompt: "edit this", image_path: "assets/victim.png", mode: "edit" },
      analysisCtx,
    );
    const input = (prepared.operation as any).request.input;

    // Approval-window attack: swap the parent directory to the host dir.
    rmSync(dirPath, { recursive: true });
    symlinkSync(hostSecretDir, dirPath);

    let capturedImageBytes: string | undefined;
    const mockRuntime = {
      async createTurnSnapshot() { return {}; },
      async resolvePlan() { return { model: "dall-e-3" }; },
      async executeImage(plan: any, req: any) {
        capturedImageBytes = req.inputImage?.data;
        return { images: [{ bytes: Buffer.from("out"), mimeType: "image/png" }] };
      },
    };

    await expect(
      generateImageRuntime(input, mockRuntime as any, undefined, undefined, {
        tenancyMode: "multi",
        capabilities: [],
        workspaceRoot: workspaceDir,
      } as any),
    ).rejects.toSatisfy((err: any) => err?.code === "PATH_IDENTITY_MISMATCH");

    expect(capturedImageBytes).toBeUndefined();
    expect(JSON.stringify(capturedImageBytes ?? "")).not.toContain(Buffer.from("HOST-IMAGE-BYTES").toString("base64"));
  });
});
