import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import {
  GrantStore,
  extractPattern,
  grantMatches,
  type Grant,
} from "../grants.js";

// ── Pure helpers ──────────────────────────────────────────────────────

describe("extractPattern", () => {
  it("returns the command string for execute_shell_command", () => {
    expect(extractPattern("execute_shell_command", { command: "npm test" })).toBe("npm test");
  });

  it("returns undefined for shell with empty/non-string command", () => {
    expect(extractPattern("execute_shell_command", { command: "" })).toBeUndefined();
    expect(extractPattern("execute_shell_command", {})).toBeUndefined();
  });

  it("returns the path string for write_file", () => {
    expect(extractPattern("write_file", { path: "/tmp/a.txt" })).toBe("/tmp/a.txt");
  });

  it("returns undefined for write_file with no path", () => {
    expect(extractPattern("write_file", {})).toBeUndefined();
  });

  it("extracts the first section path for edit_file from a hashline patch", () => {
    const patch = "[src/foo.ts#a1f2]\nSWAP 1.=3:\n+bar";
    expect(extractPattern("edit_file", { patch })).toBe("src/foo.ts");
  });

  it("returns undefined for edit_file with a multi-file patch (tool-level fallback)", () => {
    // First section path is still extracted; a user wanting all files uses tool-level.
    const patch = "[src/a.ts#a1f2]\nSWAP 1.=1:\n+x\n[src/b.ts#b2c3]\nSWAP 1.=1:\n+y";
    expect(extractPattern("edit_file", { patch })).toBe("src/a.ts");
  });

  it("returns undefined for edit_file with empty/garbage patch", () => {
    expect(extractPattern("edit_file", { patch: "" })).toBeUndefined();
    expect(extractPattern("edit_file", { patch: "no section header here" })).toBeUndefined();
    expect(extractPattern("edit_file", {})).toBeUndefined();
  });

  it("returns undefined for other tools (tool-level)", () => {
    expect(extractPattern("web_search", { query: "x" })).toBeUndefined();
  });
});

describe("grantMatches", () => {
  it("tool-level grant (no pattern) matches any args for the tool", () => {
    const g: Grant = { id: "1", tool: "web_search", scope: "session", createdAt: 0 };
    expect(grantMatches(g, "web_search", { query: "x" })).toBe(true);
  });

  it("tool-level grant does NOT match a different tool", () => {
    const g: Grant = { id: "1", tool: "web_search", scope: "session", createdAt: 0 };
    expect(grantMatches(g, "execute_shell_command", {})).toBe(false);
  });

  it("shell prefix grant matches a command that starts with the prefix", () => {
    const g: Grant = { id: "1", tool: "execute_shell_command", pattern: "npm test", scope: "project", createdAt: 0 };
    // Exact match
    expect(grantMatches(g, "execute_shell_command", { command: "npm test" })).toBe(true);
    // Extended args still match (prefix)
    expect(grantMatches(g, "execute_shell_command", { command: "npm test --watch" })).toBe(true);
  });

  it("shell prefix grant does NOT match a different program", () => {
    const g: Grant = { id: "1", tool: "execute_shell_command", pattern: "npm test", scope: "project", createdAt: 0 };
    expect(grantMatches(g, "execute_shell_command", { command: "npm install" })).toBe(false);
  });

  it("path prefix grant matches nested paths (write_file)", () => {
    const g: Grant = { id: "1", tool: "write_file", pattern: "/project/src", scope: "project", createdAt: 0 };
    expect(grantMatches(g, "write_file", { path: "/project/src/index.ts" })).toBe(true);
    expect(grantMatches(g, "write_file", { path: "/project/test/x.ts" })).toBe(false);
  });

  it("path prefix grant matches edit_file patches targeting a nested file", () => {
    const g: Grant = { id: "1", tool: "edit_file", pattern: "src/components", scope: "project", createdAt: 0 };
    expect(grantMatches(g, "edit_file", { patch: "[src/components/Button.tsx#a1f2]\nSWAP 1.=1:\n+x" })).toBe(true);
    expect(grantMatches(g, "edit_file", { patch: "[src/utils/helpers.ts#a1f2]\nSWAP 1.=1:\n+x" })).toBe(false);
  });
});

// ── GrantStore (disk-backed, tmp dirs) ─────────────────────────────────

let projectDir: string;
let globalDir: string;

beforeEach(async () => {
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "grants-project-"));
  globalDir = await fs.mkdtemp(path.join(os.tmpdir(), "grants-global-"));
});

afterEach(async () => {
  await fs.rm(projectDir, { recursive: true, force: true });
  await fs.rm(globalDir, { recursive: true, force: true });
});

describe("GrantStore", () => {
  it("returns null when no grants exist", () => {
    const store = new GrantStore({ projectDir, globalDir });
    expect(store.consult("execute_shell_command", { command: "npm test" })).toBeNull();
  });

  it("session grant is consulted without hitting disk", async () => {
    const store = new GrantStore({ projectDir, globalDir });
    await store.add("execute_shell_command", "session", "npm test");

    expect(store.consult("execute_shell_command", { command: "npm test" })).not.toBeNull();
    expect(store.consult("execute_shell_command", { command: "npm test --watch" })).not.toBeNull();
    expect(store.consult("execute_shell_command", { command: "npm install" })).toBeNull();
  });

  it("project grant persists to disk and survives a new store instance", async () => {
    const store1 = new GrantStore({ projectDir, globalDir });
    await store1.add("execute_shell_command", "project", "npm test");

    // New store reading the same project dir sees the grant
    const store2 = new GrantStore({ projectDir, globalDir });
    expect(store2.consult("execute_shell_command", { command: "npm test --watch" })).not.toBeNull();
  });

  it("global grant is read from the global dir", async () => {
    const store = new GrantStore({ projectDir, globalDir });
    await store.add("web_search", "global"); // tool-level (no pattern)

    const store2 = new GrantStore({ projectDir, globalDir });
    expect(store2.consult("web_search", { query: "anything" })).not.toBeNull();
  });

  it("consult checks session → project → global (first match wins)", async () => {
    const store = new GrantStore({ projectDir, globalDir });
    // Add a broad global grant and a narrower session grant
    await store.add("execute_shell_command", "global"); // tool-level
    await store.add("execute_shell_command", "session", "npm test"); // pattern

    const matched = store.consult("execute_shell_command", { command: "npm test" });
    // Session (pattern) should win over global (tool-level) even though both match
    expect(matched?.scope).toBe("session");
    expect(matched?.pattern).toBe("npm test");
  });

  it("list filters by scope", async () => {
    const store = new GrantStore({ projectDir, globalDir });
    await store.add("execute_shell_command", "session", "npm test");
    await store.add("web_search", "project");

    expect(store.list("session")).toHaveLength(1);
    expect(store.list("project")).toHaveLength(1);
    expect(store.list("global")).toHaveLength(0);
    expect(store.list()).toHaveLength(2);
  });

  it("remove deletes by id across scopes", async () => {
    const store = new GrantStore({ projectDir, globalDir });
    const g1 = await store.add("execute_shell_command", "session", "npm test");
    const g2 = await store.add("web_search", "project");

    expect(await store.remove(g1.id)).toBe(true);
    expect(await store.remove(g2.id)).toBe(true);
    expect(store.list()).toHaveLength(0);
    expect(await store.remove("nonexistent")).toBe(false);
  });

  it("clear wipes a scope", async () => {
    const store = new GrantStore({ projectDir, globalDir });
    await store.add("execute_shell_command", "session", "npm test");
    await store.add("web_search", "project");
    await store.add("read_file", "global");

    await store.clear("session");
    expect(store.list("session")).toHaveLength(0);
    expect(store.list("project")).toHaveLength(1); // untouched

    await store.clear("project");
    expect(store.list("project")).toHaveLength(0);

    // Global survives
    expect(store.list("global")).toHaveLength(1);
  });

  it("survives a corrupt grants.json (degrades to no grants)", async () => {
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, "grants.json"), "not valid json {{{", "utf-8");

    const store = new GrantStore({ projectDir, globalDir });
    expect(store.consult("execute_shell_command", { command: "npm test" })).toBeNull();
    expect(store.list("project")).toHaveLength(0);
  });
});
