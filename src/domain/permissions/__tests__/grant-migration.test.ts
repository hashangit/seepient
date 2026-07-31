/**
 * P1 legacy grant migration + quarantine test (spec 008, T111).
 *
 * Verifies: only provably-exact path grants convert; shell-prefix, path-
 * prefix, malformed, and tool-level grants are quarantined (inactive);
 * converted capabilities are de-duplicated.
 */
import { describe, it, expect } from "vitest";
import {
  classifyLegacyGrant,
  migrateLegacyGrants,
} from "../grant-migration.js";
import type { Grant } from "../../grants.js";

function grant(tool: string, pattern: string | undefined, scope: "project" | "global" | "session" = "project"): Grant {
  return { id: "g1", tool, pattern, scope, createdAt: 0 };
}

describe("classifyLegacyGrant (T111)", () => {
  it("converts an exact canonical path grant for write_file", () => {
    const o = classifyLegacyGrant(grant("write_file", "/proj/a.txt"));
    expect(o.status).toBe("converted");
    if (o.status === "converted") {
      expect(o.capability).toEqual({ kind: "commit-file", path: "/proj/a.txt" });
    }
  });

  it("quarantines path-prefix grants (trailing slash)", () => {
    const o = classifyLegacyGrant(grant("write_file", "/proj/"));
    expect(o.status).toBe("quarantined");
    if (o.status === "quarantined") expect(o.reason).toBe("path-prefix-not-exact");
  });

  it("quarantines shell string-prefix grants (never safely convertible)", () => {
    const o = classifyLegacyGrant(grant("execute_shell_command", "npm test"));
    expect(o.status).toBe("quarantined");
    if (o.status === "quarantined") expect(o.reason).toBe("shell-prefix-not-exact");
  });

  it("quarantines non-canonical paths (relative, .., //)", () => {
    expect(classifyLegacyGrant(grant("write_file", "relative/path")).status).toBe("quarantined");
    expect(classifyLegacyGrant(grant("write_file", "/a/../b")).status).toBe("quarantined");
    expect(classifyLegacyGrant(grant("write_file", "/a//b")).status).toBe("quarantined");
  });

  it("quarantines tool-level grants (no pattern → ambiguous)", () => {
    const o = classifyLegacyGrant(grant("write_file", undefined));
    expect(o.status).toBe("quarantined");
    if (o.status === "quarantined") expect(o.reason).toBe("ambiguous-target");
  });

  it("ignores session-scope grants (process-lifetime, no migration needed)", () => {
    const o = classifyLegacyGrant(grant("write_file", "/proj/a.txt", "session"));
    expect(o.status).toBe("ignored");
  });

  it("ignores unsupported tools", () => {
    const o = classifyLegacyGrant(grant("custom_tool", "/proj/a.txt"));
    expect(o.status).toBe("ignored");
  });
});

describe("migrateLegacyGrants (T111)", () => {
  it("de-duplicates converted capabilities", () => {
    const grants = [
      grant("write_file", "/proj/a.txt"),
      grant("write_file", "/proj/a.txt"), // duplicate
      grant("write_file", "/proj/b.txt"),
    ];
    const result = migrateLegacyGrants(grants);
    expect(result.capabilities.capabilities).toHaveLength(2);
    expect(result.quarantined).toEqual([]);
  });

  it("returns quarantined grants with their reasons", () => {
    const grants = [
      grant("write_file", "/proj/"),
      grant("execute_shell_command", "npm test"),
    ];
    const result = migrateLegacyGrants(grants);
    expect(result.capabilities.capabilities).toHaveLength(0);
    expect(result.quarantined).toHaveLength(2);
    expect(result.quarantined.map((q) => q.reason).sort()).toEqual([
      "path-prefix-not-exact",
      "shell-prefix-not-exact",
    ]);
  });

  it("property: no ambiguous grant becomes a capability", () => {
    const grants = [
      grant("write_file", "/proj/"), // prefix
      grant("write_file", "/a/../b"), // non-canonical
      grant("execute_shell_command", "ls"), // shell
      grant("write_file", undefined), // tool-level
    ];
    const result = migrateLegacyGrants(grants);
    expect(result.capabilities.capabilities).toHaveLength(0);
    expect(result.quarantined).toHaveLength(4);
  });
});
