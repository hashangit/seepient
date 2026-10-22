/**
 * Declared governed operations — the neutral class contract for the retained
 * app-side tool surface (spec 029, M05, T014–T016; FR-007/FR-008 as applied
 * to the trusted-host bridge).
 *
 * Every static retained tool (the 63 declared in the operation inventory)
 * carries a CLASS-TYPED `TrustedHostToolDeclaration` so the engine's
 * registration analyzer, policy engine, and audit trail see the tool's real
 * declared effects and risk instead of the ambient-authority fallback
 * ("destructive" + host-callback + sensitive model-egress).
 *
 * This module is ENGINE-IMPORT-FREE by design (adapter layering rule): the
 * shapes below mirror the engine's `TrustedHostToolDeclaration`
 * (foundations/contracts/custom-tools.ts) structurally. The adapter passes
 * them through as structural matches.
 *
 * Classification source of truth:
 *   vault 029/m04-m10-governed-runtime-cutover/operation-inventory.md
 *   (per-row class assignments, Targets and Credentials columns).
 */

/** Governance class of a retained operation. */
export type GovernedOperationClass =
  | "computer"
  | "memory"
  | "scheduling"
  | "work"
  | "connector"
  | "messaging"
  | "audio";

/**
 * Risk categories accepted by the engine's trusted-host declaration
 * validator (registration-dispatch.ts). The engine's static
 * `ToolRiskCategory` type names a subset; the runtime validator's accepted
 * set is authoritative and mirrored here.
 */
export type GovernedToolRisk = "safe" | "read" | "edit" | "sensitive" | "destructive";

/** Mirrors the engine's `TrustedHostToolEffectDeclaration`. */
export type GovernedToolEffect =
  | { kind: "network-egress"; destinations: ReadonlyArray<unknown> | "dynamic" }
  | { kind: "secret-use"; secretRefs: string[] }
  | { kind: "model-egress"; dataClasses: string[]; providerClass?: string; sources?: string[] };

/** Mirror of the engine's `ToolEffectKind` vocabulary (display-only here). */
export type GovernedToolEffectKind =
  | "filesystem-read"
  | "filesystem-write"
  | "process-exec"
  | "network-egress"
  | "external-send"
  | "secret-use"
  | "model-egress"
  | "security-policy-change"
  | "software-activation"
  | "host-callback";

/** Structural mirror of the engine's `TrustedHostToolDeclaration`. */
export interface GovernedToolDeclaration {
  effects?: GovernedToolEffect[];
  risk?: GovernedToolRisk;
  display?: {
    title?: string;
    summary?: string;
    canonicalTargets?: string[];
    effects?: GovernedToolEffectKind[];
  };
}

/** One governed operation: its class plus the declaration shipped to the engine. */
export interface GovernedOperation {
  class: GovernedOperationClass;
  declaration: GovernedToolDeclaration;
}

type Decl = GovernedToolDeclaration;

// ---------------------------------------------------------------------------
// Declaration builders. `hostDisplay` labels every retained tool honestly:
// each one executes app-side as a host callback (trusted-host bridge).
// ---------------------------------------------------------------------------

/** Host-surface tool: no declared effect kinds beyond the host callback. */
function host(risk: GovernedToolRisk, title: string, summary: string, targets: string[]): Decl {
  return { risk, display: { title, summary, canonicalTargets: targets, effects: ["host-callback"] } };
}

/** Web/connector egress tool: dynamic network destination. */
function egress(risk: GovernedToolRisk, title: string, summary: string, targets: string[]): Decl {
  return {
    risk,
    effects: [{ kind: "network-egress", destinations: "dynamic" }],
    display: {
      title,
      summary,
      canonicalTargets: targets,
      effects: ["network-egress", "host-callback"],
    },
  };
}

/** Outbound messaging tool: content egresses to the model-visible channel. */
function outbound(title: string, summary: string, targets: string[]): Decl {
  return {
    risk: "sensitive",
    effects: [{ kind: "model-egress", dataClasses: ["normal", "sensitive"] }],
    display: { title, summary, canonicalTargets: targets, effects: ["model-egress", "host-callback"] },
  };
}

/** Protected-secret tool: the value itself never becomes model-visible. */
function secretTool(title: string, summary: string, targets: string[]): Decl {
  return {
    risk: "sensitive",
    display: {
      title,
      summary,
      canonicalTargets: targets,
      effects: ["secret-use", "host-callback"],
    },
  };
}

/**
 * The governed operations, keyed by the APP-SIDE tool name — the real
 * retained-service name BEFORE the engine `app_` namespacing applied at the
 * bridge (`read_file`/`write_file`/`web_search` collide with engine
 * built-ins and surface as `app_*`; the governed executor still receives the
 * real name). One entry per statically declared tool; dynamic connector
 * tools (`<connector>_<tool>`) are NOT here — they ride the dynamic class at
 * the bridge (network-egress "dynamic" fallback today).
 */
export const GOVERNED_OPERATIONS: Record<string, GovernedOperation> = {
  // --- computer (T015): host screen, input, page browser, files, shell ------
  computer_observe: {
    class: "computer",
    declaration: host("read", "Observe computer", "Read the computer host screen frame", ["computer-host:screen"]),
  },
  computer_act: {
    class: "computer",
    declaration: host("destructive", "Control computer", "Send input events to the computer host (click, type, key, scroll)", ["computer-host:input"]),
  },
  browser_navigate: {
    class: "computer",
    declaration: host("destructive", "Navigate page browser", "Navigate the page browser on the leased computer screen", ["computer-host:page-browser", "web"]),
  },
  browser_snapshot: {
    class: "computer",
    declaration: host("read", "Snapshot page browser", "Read the page browser accessibility snapshot", ["computer-host:page-browser"]),
  },
  browser_act: {
    class: "computer",
    // Saved login secrets can be injected via fill_secret — the material is
    // never returned to the model, so no secret-use ref is declarable.
    declaration: host(
      "destructive",
      "Act in page browser",
      "Interact with the page browser (click, fill, type); may inject the saved login secret for credential fields",
      ["computer-host:page-browser"],
    ),
  },
  list_files: {
    class: "computer",
    declaration: host("read", "List files", "List files in the bot home on the computer host", ["computer-host:bot-home"]),
  },
  read_file: {
    class: "computer",
    declaration: host("read", "Read file", "Read a file from the bot home on the computer host", ["computer-host:bot-home"]),
  },
  write_file: {
    class: "computer",
    declaration: host("edit", "Write file", "Write a file in the bot home on the computer host", ["computer-host:bot-home"]),
  },
  attach_file: {
    class: "computer",
    declaration: host("edit", "Attach file", "Publish a workspace file to the thread timeline as an artifact", ["artifacts-store", "thread-timeline"]),
  },
  shell: {
    class: "computer",
    // Bot command-variable secrets ride the process environment (registered
    // for redaction) — refs are dynamic, so no static secret-use declaration.
    declaration: host(
      "destructive",
      "Run shell command",
      "Execute a shell command on the computer host; bot command-variable secrets ride the environment",
      ["computer-host:shell"],
    ),
  },
  open_path: {
    class: "computer",
    declaration: host("destructive", "Open path", "Open a file or URL with the computer host's default app", ["computer-host"]),
  },
  launch_app: {
    class: "computer",
    declaration: host("destructive", "Launch app", "Focus or launch an application on the computer host", ["computer-host"]),
  },
  render_plot: {
    class: "computer",
    declaration: host("edit", "Render plot", "Render a chart and write it to the computer workspace and thread", ["computer-host:workspace", "thread-timeline"]),
  },
  request_takeover: {
    class: "computer",
    declaration: host("destructive", "Request takeover", "Human takeover of the computer host", ["computer-host", "user"]),
  },

  // --- memory (T014) --------------------------------------------------------
  remember: {
    class: "memory",
    declaration: host("edit", "Remember", "Commit content to the bot Markdown memory", ["memory-store"]),
  },
  save_shared_memory: {
    class: "memory",
    declaration: host("edit", "Save shared memory", "Commit content to the space shared memory doc", ["memory-store:shared"]),
  },
  save_memory: {
    class: "memory",
    // Memory-provider credential is config-side; no secret crosses the tool.
    declaration: host("edit", "Save semantic memory", "Save content to the space semantic memory provider", ["semantic-memory-provider"]),
  },
  recall_memory: {
    class: "memory",
    declaration: host("read", "Recall memory", "Query the space semantic memory provider", ["semantic-memory-provider"]),
  },
  forget_memory: {
    class: "memory",
    declaration: host("edit", "Forget memory", "Delete an entry from the space semantic memory provider", ["semantic-memory-provider"]),
  },
  search_history: {
    class: "memory",
    declaration: host("read", "Search history", "Search the redacted message store", ["message-store"]),
  },
  read_history: {
    class: "memory",
    declaration: host("read", "Read history", "Read messages from the message store", ["message-store"]),
  },

  // --- scheduling (T014) ------------------------------------------------------
  schedule_create: {
    class: "scheduling",
    declaration: host("edit", "Create schedule", "Create a routine in the scheduler and enqueue its wakeup job", ["scheduler", "work-queue"]),
  },
  schedule_list: {
    class: "scheduling",
    declaration: host("read", "List schedules", "List the bot's routines in the scheduler", ["scheduler"]),
  },
  schedule_cancel: {
    class: "scheduling",
    declaration: host("edit", "Cancel schedule", "Cancel a routine and its queued wakeup jobs", ["scheduler", "work-queue"]),
  },

  // --- work (T014): scratchpad, tickets, skills, delegation, spaces ----------
  task_catalog: {
    class: "work",
    declaration: host("read", "Task catalog", "List tasks, routines, skills, and exposed tools in the work inventory", ["work-inventory"]),
  },
  scratchpad_list: {
    class: "work",
    declaration: host("read", "List scratchpad", "List the bot's scratchpad items", ["work-queue:scratchpad"]),
  },
  scratchpad_add: {
    class: "work",
    declaration: host("edit", "Add scratchpad item", "Add an item to the bot's scratchpad", ["work-queue:scratchpad"]),
  },
  scratchpad_update: {
    class: "work",
    declaration: host("edit", "Update scratchpad item", "Update a bot scratchpad item", ["work-queue:scratchpad"]),
  },
  scratchpad_complete: {
    class: "work",
    declaration: host("edit", "Complete scratchpad item", "Mark a bot scratchpad item done", ["work-queue:scratchpad"]),
  },
  scratchpad_remove: {
    class: "work",
    declaration: host("edit", "Remove scratchpad item", "Remove a bot scratchpad item", ["work-queue:scratchpad"]),
  },
  board_tickets: {
    class: "work",
    declaration: host("read", "List board tickets", "List tickets on the ticket board", ["work:tickets"]),
  },
  ticket_get: {
    class: "work",
    declaration: host("read", "Get ticket", "Read one ticket", ["work:tickets"]),
  },
  ticket_create: {
    class: "work",
    declaration: host("edit", "Create ticket", "Create a ticket on the board", ["work:tickets"]),
  },
  ticket_update: {
    class: "work",
    declaration: host("edit", "Update ticket", "Update a ticket on the board", ["work:tickets"]),
  },
  ticket_comment: {
    class: "work",
    declaration: host("edit", "Comment on ticket", "Comment on a ticket", ["work:tickets"]),
  },
  skill_read: {
    class: "work",
    declaration: host("read", "Read skill", "Read a SKILL.md from the skill catalog", ["skill-store"]),
  },
  skill_create: {
    class: "work",
    declaration: host("edit", "Create skill", "Create a skill in the space-shared skill store", ["skill-store"]),
  },
  skill_update: {
    class: "work",
    declaration: host("edit", "Update skill", "Update a user-created skill", ["skill-store"]),
  },
  skill_delete: {
    class: "work",
    declaration: host("edit", "Delete skill", "Delete a user-created skill", ["skill-store"]),
  },
  // Documented stub until M08 (Scenario 22) — declared as the work-class
  // helper it will become.
  run_subagent: {
    class: "work",
    declaration: host("edit", "Run subagent", "Delegate a task to an in-turn helper bot", ["helper-bot"]),
  },
  create_space: {
    class: "work",
    declaration: host("edit", "Create space", "Create a space in the org space registry (explicit approval)", ["space-registry"]),
  },
  spawn_bot: {
    class: "work",
    declaration: host("edit", "Spawn bot", "Spawn a child bot with optional computer provisioning", ["bot-catalog", "computer-host"]),
  },
  update_bot: {
    class: "work",
    declaration: host("edit", "Update bot", "Update the bot's own profile in the bot catalog", ["bot-catalog"]),
  },
  archive_bot: {
    class: "work",
    declaration: host("edit", "Archive bot", "Archive a spawned child bot (approval-gated)", ["bot-catalog"]),
  },

  // --- connector (T016): web, cloud agents, MCP, secret surface -------------
  web_search: {
    class: "connector",
    declaration: egress("read", "Web search", "Search the web via the configured provider (vendor key optional)", ["web"]),
  },
  web_fetch: {
    class: "connector",
    declaration: egress("read", "Fetch web page", "Fetch a URL via the configured web provider (vendor key optional)", ["web"]),
  },
  cloud_agent_launch: {
    class: "connector",
    declaration: egress("edit", "Launch cloud agent", "Launch a cloud agent session with the cloud agent vendor credential", ["cloud-agent-provider"]),
  },
  cloud_agent_status: {
    class: "connector",
    declaration: egress("read", "Cloud agent status", "Query a cloud agent session status with the cloud agent vendor credential", ["cloud-agent-provider"]),
  },
  cloud_agent_reply: {
    class: "connector",
    declaration: egress("edit", "Reply to cloud agent", "Send a follow-up prompt to a cloud agent session with the cloud agent vendor credential", ["cloud-agent-provider"]),
  },
  cloud_agent_cancel: {
    class: "connector",
    declaration: egress("edit", "Cancel cloud agent", "Cancel a cloud agent session with the cloud agent vendor credential", ["cloud-agent-provider"]),
  },
  add_mcp_server: {
    class: "connector",
    // The user-supplied token/env is stored as a connector credential
    // backend-side; the value is not a declarable static ref.
    declaration: egress(
      "edit",
      "Add MCP server",
      "Register an MCP connector server; user-supplied credentials are stored as connector credentials",
      ["mcp-connector-registry"],
    ),
  },
  list_secrets: {
    class: "connector",
    declaration: secretTool("List secrets", "List bot secret names — protected-secret metadata only, values never returned", ["bot-secret-store"]),
  },
  forget_secret: {
    class: "connector",
    declaration: secretTool("Forget secret", "Delete a bot secret from protected storage (approval-gated)", ["bot-secret-store"]),
  },
  request_secret: {
    class: "connector",
    declaration: secretTool(
      "Request secret",
      "Ask the user for a secret via a protected ask card; the value is stored protected-side and never model-visible",
      ["protected-ask-card", "bot-secret-store"],
    ),
  },
  secret_request: {
    class: "connector",
    declaration: egress(
      "sensitive",
      "Authenticated request",
      "Perform an HTTP request with the bot credential injected backend-side at its saved origin (approval-gated)",
      ["connector-http"],
    ),
  },

  // --- messaging (T016) -------------------------------------------------------
  message_user: {
    class: "messaging",
    declaration: outbound("Message user", "Post a progress message to the thread timeline", ["thread-timeline"]),
  },
  message_bot: {
    class: "messaging",
    declaration: outbound("Message bot", "Deliver a message to another bot's thread", ["messaging:cross-bot"]),
  },
  handoff_to_bot: {
    class: "messaging",
    declaration: outbound("Hand off to bot", "Transfer the group conversation to another bot", ["messaging:group-stage"]),
  },
  connect_agent: {
    class: "messaging",
    // Messaging platform identity is deployment-channel config, not a tool arg.
    declaration: outbound("Connect agent", "Request an agent connection over the messaging platform identity", ["agent-connection-registry", "messaging-channel"]),
  },
  respond_agent_connection: {
    class: "messaging",
    declaration: host("edit", "Respond to agent connection", "Accept or reject a pending agent connection", ["agent-connection-registry"]),
  },
  message_agent: {
    class: "messaging",
    declaration: outbound("Message agent", "Send a message over an approved agent connection (messaging platform identity)", ["messaging-channel"]),
  },
  ask_user: {
    class: "messaging",
    declaration: outbound("Ask user", "Present a question card to the user", ["user:ask-card"]),
  },

  // --- audio (T016) -----------------------------------------------------------
  end_call: {
    class: "audio",
    declaration: outbound("End call", "Post the farewell message and end the voice call", ["messaging-channel", "voice-call"]),
  },
};

/**
 * Exact-name lookup for a governed operation. Names are the APP-SIDE tool
 * names (pre-`app_`-namespacing) — the same name the governed executor
 * receives in `request.executeTool`.
 */
export function governedDeclarationFor(toolName: string): GovernedOperation | undefined {
  return GOVERNED_OPERATIONS[toolName];
}
