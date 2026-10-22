/**
 * Declared governed operations (spec 029, M05, T014–T016).
 *
 * The name list below is the inventory snapshot: every statically declared
 * retained tool in
 * `029-rakazo-port/m04-m10-governed-runtime-cutover/operation-inventory.md`
 * (63 rows, taken 2026-10-22 at baseline aa1ac67376762ba4673a6fb95f8659f8f6ea641a).
 * The dynamic connector row (`<connector>_<tool>`) is intentionally absent —
 * it is live-catalog scope, not a static declaration.
 */
import { describe, expect, it } from "vitest";
import { GOVERNED_OPERATIONS, governedDeclarationFor, type GovernedToolDeclaration } from "./governed-operations.js";

const INVENTORY_STATIC_TOOL_NAMES: readonly string[] = [
  "computer_observe",
  "computer_act",
  "browser_navigate",
  "browser_snapshot",
  "browser_act",
  "list_files",
  "read_file",
  "write_file",
  "attach_file",
  "shell",
  "open_path",
  "launch_app",
  "request_takeover",
  "ask_user",
  "message_user",
  "request_secret",
  "list_secrets",
  "secret_request",
  "forget_secret",
  "render_plot",
  "add_mcp_server",
  "remember",
  "save_shared_memory",
  "web_search",
  "web_fetch",
  "cloud_agent_launch",
  "cloud_agent_status",
  "cloud_agent_reply",
  "cloud_agent_cancel",
  "search_history",
  "read_history",
  "save_memory",
  "recall_memory",
  "forget_memory",
  "task_catalog",
  "scratchpad_list",
  "scratchpad_add",
  "scratchpad_update",
  "scratchpad_complete",
  "scratchpad_remove",
  "board_tickets",
  "ticket_get",
  "ticket_create",
  "ticket_update",
  "ticket_comment",
  "schedule_create",
  "schedule_list",
  "schedule_cancel",
  "end_call",
  "skill_read",
  "skill_create",
  "skill_update",
  "skill_delete",
  "run_subagent",
  "create_space",
  "spawn_bot",
  "update_bot",
  "archive_bot",
  "message_bot",
  "handoff_to_bot",
  "connect_agent",
  "respond_agent_connection",
  "message_agent",
];

const GOVERNED_CLASSES = ["computer", "memory", "scheduling", "work", "connector", "messaging", "audio"];
const RISKS = ["safe", "read", "edit", "sensitive", "destructive"];
const EFFECT_KINDS = [
  "filesystem-read",
  "filesystem-write",
  "process-exec",
  "network-egress",
  "external-send",
  "secret-use",
  "model-egress",
  "security-policy-change",
  "software-activation",
  "host-callback",
];
const DECLARED_EFFECT_KINDS = ["network-egress", "secret-use", "model-egress"];

/** Engine-side structural validation of one declaration (registration-dispatch rules). */
function expectValidDeclaration(declaration: GovernedToolDeclaration): void {
  if (declaration.risk !== undefined) {
    expect(RISKS).toContain(declaration.risk);
  }
  if (declaration.effects !== undefined) {
    for (const effect of declaration.effects) {
      expect(DECLARED_EFFECT_KINDS).toContain(effect.kind);
      if (effect.kind === "network-egress") {
        // "dynamic" or destinations the engine's URL/host parsing accepts:
        // plain hostnames or http(s) URLs only (never objects here).
        if (effect.destinations !== "dynamic") {
          expect(effect.destinations.length).toBeGreaterThan(0);
          for (const destination of effect.destinations) {
            expect(typeof destination).toBe("string");
            expect(() => new URL(`https://${destination as string}`)).not.toThrow();
          }
        }
      } else if (effect.kind === "secret-use") {
        expect(effect.secretRefs.length).toBeGreaterThan(0);
      } else {
        expect(effect.dataClasses.length).toBeGreaterThan(0);
      }
    }
  }
  const display = declaration.display;
  expect(display).toBeDefined();
  expect(display?.summary).toBeTruthy();
  expect(display?.canonicalTargets?.length).toBeGreaterThan(0);
  expect(display?.effects?.length).toBeGreaterThan(0);
  for (const effectKind of display?.effects ?? []) {
    expect(EFFECT_KINDS).toContain(effectKind);
  }
}

describe("governed operations (T014–T016)", () => {
  it("covers every statically declared inventoried tool", () => {
    for (const name of INVENTORY_STATIC_TOOL_NAMES) {
      const operation = governedDeclarationFor(name);
      expect(operation, `missing governed operation for ${name}`).toBeDefined();
      expect(GOVERNED_CLASSES).toContain(operation!.class);
      expectValidDeclaration(operation!.declaration);
    }
    expect(Object.keys(GOVERNED_OPERATIONS).length).toBe(INVENTORY_STATIC_TOOL_NAMES.length);
  });

  it("every entry carries a declaration (no ambient fallback rows)", () => {
    for (const [name, operation] of Object.entries(GOVERNED_OPERATIONS)) {
      expect(operation.declaration, name).toBeDefined();
      expect(INVENTORY_STATIC_TOOL_NAMES, name).toContain(name);
    }
  });

  it("looks up by exact name only", () => {
    expect(governedDeclarationFor("read_file")?.class).toBe("computer");
    expect(governedDeclarationFor("app_read_file")).toBeUndefined();
    expect(governedDeclarationFor("READ_FILE")).toBeUndefined();
    expect(governedDeclarationFor("no_such_tool")).toBeUndefined();
    expect(governedDeclarationFor("")).toBeUndefined();
  });

  it("classifies the inventory's T014/T015/T016 assignments", () => {
    expect(governedDeclarationFor("remember")?.class).toBe("memory");
    expect(governedDeclarationFor("schedule_create")?.class).toBe("scheduling");
    expect(governedDeclarationFor("ticket_create")?.class).toBe("work");
    expect(governedDeclarationFor("computer_act")?.class).toBe("computer");
    expect(governedDeclarationFor("shell")?.class).toBe("computer");
    expect(governedDeclarationFor("web_search")?.class).toBe("connector");
    expect(governedDeclarationFor("cloud_agent_launch")?.class).toBe("connector");
    expect(governedDeclarationFor("message_user")?.class).toBe("messaging");
    expect(governedDeclarationFor("end_call")?.class).toBe("audio");
  });

  it("declares honest risk and effects per class", () => {
    // Host input/screen → destructive with host-callback display.
    expect(governedDeclarationFor("computer_act")!.declaration.risk).toBe("destructive");
    expect(governedDeclarationFor("computer_act")!.declaration.display?.effects).toContain("host-callback");
    // File/registry reads → read.
    expect(governedDeclarationFor("read_file")!.declaration.risk).toBe("read");
    expect(governedDeclarationFor("scratchpad_list")!.declaration.risk).toBe("read");
    // Shell → destructive; bot command-variable secrets ride env (no secret-use ref).
    const shell = governedDeclarationFor("shell")!.declaration;
    expect(shell.risk).toBe("destructive");
    expect(shell.effects).toBeUndefined();
    expect(shell.display?.summary).toContain("environment");
    // Memory/scratchpad/skill writes → edit.
    expect(governedDeclarationFor("remember")!.declaration.risk).toBe("edit");
    expect(governedDeclarationFor("skill_create")!.declaration.risk).toBe("edit");
    // Web egress → dynamic destinations + read.
    const webSearch = governedDeclarationFor("web_search")!.declaration;
    expect(webSearch.risk).toBe("read");
    expect(webSearch.effects).toEqual([{ kind: "network-egress", destinations: "dynamic" }]);
    // Outbound messaging → sensitive with normal+sensitive model egress.
    const messageUser = governedDeclarationFor("message_user")!.declaration;
    expect(messageUser.risk).toBe("sensitive");
    expect(messageUser.effects).toEqual([{ kind: "model-egress", dataClasses: ["normal", "sensitive"] }]);
    // Secret surface → sensitive with protected-secret summary.
    expect(governedDeclarationFor("list_secrets")!.declaration.risk).toBe("sensitive");
    expect(governedDeclarationFor("request_secret")!.declaration.display?.summary).toContain("never model-visible");
    expect(governedDeclarationFor("secret_request")!.declaration.effects?.[0]?.kind).toBe("network-egress");
    // Takeover → destructive with the human-takeover summary.
    const takeover = governedDeclarationFor("request_takeover")!.declaration;
    expect(takeover.risk).toBe("destructive");
    expect(takeover.display?.summary).toContain("Human takeover");
  });
});
