/**
 * Project-local .env security filter tests (spec 019 FR-007, T026, QS-0.7).
 *
 * A hostile repo's committed .env must not control Seepient's security
 * switches: the three refused variables produce ONE stderr warning each and
 * never enter process.env. Real environment variables still win (dotenv
 * precedence preserved).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProjectEnv, DOTENV_REFUSED_VARS } from "../dotenv-guard.js";

let dir: string;
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seepient-env-"));
  // Keep the test hermetic: snapshot then clear the refused vars.
  for (const key of DOTENV_REFUSED_VARS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  savedEnv.set("SEEPIENT_DOTENV_BENIGN", process.env.SEEPIENT_DOTENV_BENIGN);
  delete process.env.SEEPIENT_DOTENV_BENIGN;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const [key, val] of savedEnv) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
  savedEnv.clear();
});

function withCapturedStderr<T>(fn: () => T): { result: T; stderr: string } {
  const chunks: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    return { result: fn(), stderr: chunks.join("") };
  } finally {
    process.stderr.write = original;
  }
}

describe("dotenv security guard (spec 019 FR-007, QS-0.7)", () => {
  it("refuses security switches with one warning and never sets them", () => {
    writeFileSync(
      join(dir, ".env"),
      [
        "SEEPIENT_UNCONTAINED=1",
        "SEEPIENT_FS_COMMIT_BIN=/attacker/bin",
        "SEEPIENT_DOTENV_BENIGN=hello",
      ].join("\n"),
      "utf8",
    );

    const { stderr } = withCapturedStderr(() => loadProjectEnv(join(dir, ".env")));

    expect(process.env.SEEPIENT_UNCONTAINED).toBeUndefined();
    expect(process.env.SEEPIENT_FS_COMMIT_BIN).toBeUndefined();
    // Exactly one warning line per refused variable, each naming the var.
    for (const key of DOTENV_REFUSED_VARS) {
      const lines = stderr.split("\n").filter((l) => l.includes(key));
      expect(lines.length, `warning for ${key}`).toBe(1);
    }
    // Benign variables from the same file still load.
    expect(process.env.SEEPIENT_DOTENV_BENIGN).toBe("hello");
  });

  it("real environment variables still win over the file", () => {
    process.env.SEEPIENT_DOTENV_BENIGN = "from-real-env";
    writeFileSync(join(dir, ".env"), "SEEPIENT_DOTENV_BENIGN=from-file\n", "utf8");

    withCapturedStderr(() => loadProjectEnv(join(dir, ".env")));

    expect(process.env.SEEPIENT_DOTENV_BENIGN).toBe("from-real-env");
  });

  it("a missing .env is a silent no-op", () => {
    const { stderr } = withCapturedStderr(() => loadProjectEnv(join(dir, ".env")));
    expect(stderr).toBe("");
  });
});
