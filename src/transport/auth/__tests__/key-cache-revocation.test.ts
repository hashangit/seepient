/**
 * Key cache cross-process revocation (spec 022-5 FR-010 / SC-007).
 *
 * The cache publishes only when the file is unchanged across the read, so a
 * revocation written by a second process (atomic rename) is observed within
 * one re-read instead of being pinned until the NEXT file change.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateApiKey, validateApiKey } from "../auth.js";

describe("key cache cross-process revocation (022-5 FR-010 / SC-007)", () => {
  let dir: string;
  let keyFile: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "seepient-keyrevoke-"));
    keyFile = join(dir, "server-keys.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a revocation written by a second process is observed within one re-read", () => {
    const generated = generateApiKey(["agent:run"], { filePath: keyFile });
    expect(validateApiKey(generated.rawKey, { filePath: keyFile })).not.toBeNull();

    // Prime the cache.
    expect(validateApiKey(generated.rawKey, { filePath: keyFile })).not.toBeNull();

    // A second process revokes the key via an atomic rename (the exact
    // external-writer shape that used to pin {newMtime, oldKeys}).
    const child = `const fs=require("fs");const f=${JSON.stringify(keyFile)};const s=JSON.parse(fs.readFileSync(f,"utf8"));s.keys=s.keys.filter(k=>k.label!==${JSON.stringify(generated.label)});const t=f+".tmp";fs.writeFileSync(t,JSON.stringify(s));fs.renameSync(t,f);`;
    execSync(`node -e ${JSON.stringify(child)}`);
    expect(existsSync(keyFile)).toBe(true);

    // One re-read later the revoked key is refused.
    expect(validateApiKey(generated.rawKey, { filePath: keyFile })).toBeNull();
  });
});
