/**
 * Tool Approval Grants — persisted permission grants for risky tools.
 *
 * When a user approves a tool call with a scope beyond "once", the decision
 * is recorded as a grant. Before prompting again, the agent loop consults
 * the grant store; a matching grant auto-approves the call (no widget).
 *
 * Scope semantics:
 *  - session: process-lifetime, in-memory only (lost on restart/resume/clear)
 *  - project: on disk at `<cwd>/.seepient/grants.json` (survives restart)
 *  - global:  on disk at `~/.seepient/grants.json` (survives everything)
 *
 * Matching is prefix-based (the existing `startsWith` idiom from the skills
 * @path resolver):
 *  - shell  → the command string as written ("npm test" matches
 *             "npm test --watch" but NOT "npm install")
 *  - write/edit → the path string
 *  - other  → tool-level (pattern undefined → any args match)
 *
 * Grants are consulted session → project → global (first match wins).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { GrantScope } from "./types.js";

export interface Grant {
  id: string;
  tool: string;
  /** Prefix the relevant arg must start with. Undefined → tool-level grant. */
  pattern?: string;
  scope: GrantScope;
  createdAt: number;
}

/** On-disk shape for project/global grant files. */
interface GrantFile {
  grants: Grant[];
}

// ── Pattern extraction + matching ─────────────────────────────────────

/**
 * Extract the prefix string a grant should match for this tool call.
 *  - execute_shell_command → the command string
 *  - write_file / edit_file → the path string
 *  - anything else → undefined (tool-level)
 */
export function extractPattern(
  toolName: string,
  args: Record<string, unknown>,
): string | undefined {
  if (toolName === "execute_shell_command") {
    const cmd = args.command;
    return typeof cmd === "string" && cmd.length > 0 ? cmd : undefined;
  }
  if (toolName === "write_file" || toolName === "edit_file") {
    const p = args.path;
    return typeof p === "string" && p.length > 0 ? p : undefined;
  }
  return undefined;
}

/**
 * Does this grant authorize the given call?
 * Same tool name AND (no pattern on the grant → tool-level, OR the call's
 * relevant arg starts with the grant's pattern).
 */
export function grantMatches(
  grant: Grant,
  toolName: string,
  args: Record<string, unknown>,
): boolean {
  if (grant.tool !== toolName) return false;
  if (grant.pattern === undefined) return true; // tool-level grant
  const actual = extractPattern(toolName, args);
  if (actual === undefined) return false;
  return actual.startsWith(grant.pattern);
}

// ── Store ──────────────────────────────────────────────────────────────

export class GrantStore {
  private readonly sessionGrants = new Map<string, Grant>();
  private readonly projectFile: string;
  private readonly globalFile: string;

  constructor(opts: { projectDir: string; globalDir: string }) {
    this.projectFile = path.join(opts.projectDir, "grants.json");
    this.globalFile = path.join(opts.globalDir, "grants.json");
  }

  /**
   * Find a grant that authorizes this call, checking session → project →
   * global. Returns the first match or null. File read errors degrade to
   * "no grant" (never block a prompt on a corrupt file).
   */
  consult(toolName: string, args: Record<string, unknown>): Grant | null {
    // 1. Session (in-memory)
    for (const g of this.sessionGrants.values()) {
      if (grantMatches(g, toolName, args)) return g;
    }
    // 2. Project, then 3. Global (on disk)
    for (const scope of ["project", "global"] as const) {
      const grant = this.readFromDisk(scope).find((g) => grantMatches(g, toolName, args));
      if (grant) return grant;
    }
    return null;
  }

  /** Record a grant. Session grants are in-memory; others hit disk. */
  async add(tool: string, scope: GrantScope, pattern?: string): Promise<Grant> {
    const grant: Grant = {
      id: randomUUID(),
      tool,
      pattern,
      scope,
      createdAt: Date.now(),
    };
    if (scope === "session") {
      this.sessionGrants.set(grant.id, grant);
    } else {
      await this.appendToDisk(grant);
    }
    return grant;
  }

  /** All grants for a scope (or all scopes if omitted). */
  list(scope?: GrantScope): Grant[] {
    const out: Grant[] = [];
    if (!scope || scope === "session") out.push(...this.sessionGrants.values());
    if (!scope || scope === "project") out.push(...this.readFromDisk("project"));
    if (!scope || scope === "global") out.push(...this.readFromDisk("global"));
    return out;
  }

  /** Remove a grant by id. Returns true if found+removed. */
  async remove(id: string): Promise<boolean> {
    if (this.sessionGrants.delete(id)) return true;
    return (await this.removeFromDisk("project", id)) || (await this.removeFromDisk("global", id));
  }

  /** Remove all grants at a scope. */
  async clear(scope: GrantScope): Promise<void> {
    if (scope === "session") {
      this.sessionGrants.clear();
      return;
    }
    await this.writeToDisk(scope, { grants: [] });
  }

  // ── Disk helpers ────────────────────────────────────────────────────

  /** Read grants for a disk scope; empty array on missing/corrupt file. */
  private readFromDisk(scope: "project" | "global"): Grant[] {
    const file = scope === "project" ? this.projectFile : this.globalFile;
    // Synchronous read via require'd fs to keep consult() sync (it runs on
    // every tool call in the hot loop). Errors degrade to no grants.
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const syncFs = require("node:fs");
      const raw = syncFs.readFileSync(file, "utf-8");
      const parsed = JSON.parse(raw) as GrantFile;
      return Array.isArray(parsed.grants) ? parsed.grants.filter(isValidGrant) : [];
    } catch {
      return [];
    }
  }

  /** Atomic append: read current, push, write via temp + rename. */
  private async appendToDisk(grant: Grant): Promise<void> {
    const scope = grant.scope as "project" | "global";
    const current = this.readFromDisk(scope);
    current.push(grant);
    await this.writeToDisk(scope, { grants: current });
  }

  private async removeFromDisk(scope: "project" | "global", id: string): Promise<boolean> {
    const current = this.readFromDisk(scope);
    const next = current.filter((g) => g.id !== id);
    if (next.length === current.length) return false;
    await this.writeToDisk(scope, { grants: next });
    return true;
  }

  /** Atomic write via temp file + rename (mirrors SettingsManager.persist). */
  private async writeToDisk(scope: "project" | "global", data: GrantFile): Promise<void> {
    const file = scope === "project" ? this.projectFile : this.globalFile;
    try {
      const dir = path.dirname(file);
      await fs.mkdir(dir, { recursive: true });

      const tmpPath = `${file}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
      await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
      await fs.rename(tmpPath, file);
    } catch (e: any) {
      // Non-fatal: grant simply won't persist. The in-session behavior still works.
      console.warn(`Warning: could not persist grant to ${file}: ${e.message}. Grant active in-memory only.`);
    }
  }
}

function isValidGrant(g: unknown): g is Grant {
  if (typeof g !== "object" || g === null) return false;
  const o = g as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.tool === "string" &&
    (o.pattern === undefined || typeof o.pattern === "string") &&
    (o.scope === "session" || o.scope === "project" || o.scope === "global") &&
    typeof o.createdAt === "number"
  );
}
