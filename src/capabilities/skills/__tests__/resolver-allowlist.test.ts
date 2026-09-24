/**
 * Skills @path allowlist pin (R3, pass-10 P2-10): prefix containment is
 * segment-aware — sibling directories like ~/.seepient-anything must be
 * denied, while the real allowed roots still resolve.
 *
 * Note on reachability: the extractor regex cannot match `~/.`-prefixed
 * dotfiles (first path char must be [a-zA-Z0-9_]), so the sibling-bypass
 * surface is the ABSOLUTE-path form `@/Users/<home>/.seepient-x/...`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { resolveReferences } from "../resolver.js";

describe("@path resolver segment-aware allowlist", () => {
  let projectRoot: string;

  beforeAll(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "resolver-allow-"));
    writeFileSync(join(projectRoot, "note.txt"), "PROJECT-CONTENT", "utf-8");
  });

  afterAll(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("resolves a file inside the project root", async () => {
    const out = await resolveReferences("see @note.txt", projectRoot);
    expect(out).toContain("PROJECT-CONTENT");
  });

  it("denies a ~/ traversal into a sibling of ~/.seepient (prefix-only match must not pass)", async () => {
    // Reachable bypass form on the pre-R3 code: @~/seepient_documents-x/../.seepient-r3pin-sibling/secret.txt
    // resolves to <home>/.seepient-r3pin-sibling/secret.txt, which the old bare
    // startsWith('<home>/.seepient') check ALLOWED.
    const sibling = join(homedir(), ".seepient-r3pin-sibling");
    try {
      mkdirSync(sibling, { recursive: true });
      writeFileSync(join(sibling, "secret.txt"), "SIBLING-SECRET", "utf-8");

      const out = await resolveReferences(
        "see @~/seepient_documents-x/../.seepient-r3pin-sibling/secret.txt",
        projectRoot,
      );
      expect(out).not.toContain("SIBLING-SECRET");
      expect(out).toContain("Access denied");
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });
});
