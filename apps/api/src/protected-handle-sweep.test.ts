/**
 * 029 T011 (US1, FR-003) — protected-handle negative sweep.
 *
 * One deterministic battery asserting ZERO raw credential material reaches
 * the app's emission surfaces, for both credential classes (api_key binding
 * via the composition; model-oauth via the durable adapter) plus the
 * cross-class negative. No network, no real DB: prisma is mocked at the
 * client boundary with a recording proxy, secret stores are in-memory fakes.
 *
 * Surface seams exercised (file:line as of this writing):
 *  1. Composition options        apps/api/src/seepient-runtime.ts:39
 *                                apps/worker/src/seepient-runtime.ts (identical file)
 *  2. Shell-executor env         packages/adapters/src/bot-secrets.ts:159 (shellCommandEnvironment)
 *                                — the executor's process env (executor.ts:5024) is
 *                                  `commandEnvironment.env` from this seam only
 *  3. Tool audit payload         packages/adapters/src/executor.ts:2737 (toolCompletionAuditPayload)
 *  4. Product events             packages/adapters/src/executor.ts:2781 (appendToolCompletionAudit)
 *  5. Streamed output / activity packages/adapters/src/auto-review.ts:155 (redactToolArgsForReview)
 *                                packages/adapters/src/pi-runtime.ts:873 (describeToolActivity)
 *                                packages/app-core/src/events.ts:467 (createStreamingRedactor)
 *  6. Transcript                 packages/adapters/src/executor.ts:7097-7105 (redactBlocks +
 *                                containsSecret fail-closed guard; redactBlocks itself is a
 *                                private closure — asserted at the exported guard seam)
 *  7. Cross-class resolution     packages/db/src/model-credentials.ts:251 (findModelCredential)
 *                                packages/adapters/src/durable-model-credential-store.ts (row())
 *  8. Debug logs                 packages/adapters/src/executor.ts:2797-2802 logs credential-adjacent
 *                                errors only after sanitizeConnectorError + redactSecrets
 *                                packages/adapters/src/connector-safety.ts:9
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  appendToolCompletionAudit,
  describeToolActivity,
  DurableModelCredentialStore,
  redactToolArgsForReview,
  serializeModelSecret,
  toOAuthCredential,
  toolCompletionAuditPayload,
  toolCompletionFromResult,
} from "@seepients/adapters";
import { containsSecret, createStreamingRedactor, redactSecrets } from "@seepients/core";
import { findModelCredential } from "@seepients/db";
// shellCommandEnvironment / sanitizeConnectorError are not re-exported from the
// package index; the sweep pins them at their defining modules.
import { shellCommandEnvironment } from "../../../packages/adapters/src/bot-secrets.js";
import { commandCredentialRedactions } from "../../../packages/adapters/src/bot-secrets.js";
import { sanitizeConnectorError } from "../../../packages/adapters/src/connector-safety.js";
import {
  seepientResolveEngineOptions,
  type SeepientAgentRuntimeDeps,
} from "./seepient-runtime.js";
import { seepientResolveEngineOptions as workerSeepientResolveEngineOptions } from "../../worker/src/seepient-runtime.js";

// ---------------------------------------------------------------------------
// Planted fixtures — the ONLY credential-shaped strings in this file.
// ---------------------------------------------------------------------------
const PLANTED_KEY = `sk-plant-${randomUUID()}`;
const PLANTED_ACCESS = `acc-plant-${randomUUID()}`;
const PLANTED_REFRESH = `ref-plant-${randomUUID()}`;
const ALL_PLANTED = [PLANTED_KEY, PLANTED_ACCESS, PLANTED_REFRESH];

const deps: SeepientAgentRuntimeDeps = {
  prisma: {} as never,
  secretStore: {} as never,
};

function apikeyRequest() {
  return {
    model: { provider: "openrouter", id: "openai/gpt-6-luna", apiKey: PLANTED_KEY },
  } as never;
}

function oauthRequest() {
  return {
    model: {
      provider: "anthropic",
      id: "claude-sonnet-5",
      oauth: {
        credential: {
          type: "oauth",
          access: PLANTED_ACCESS,
          refresh: PLANTED_REFRESH,
          expires: Date.now() + 60_000,
        },
        handle: { credentialId: "cred-1", secretId: "sec-1", userId: "u1", spaceId: "s1" },
      },
    },
  } as never;
}

/** Prisma client mock that records every TABLE touched and refuses all others. */
function recordingPrisma(tables: Record<string, Record<string, unknown>>) {
  const accessed = new Set<string>();
  const prisma = new Proxy(
    {},
    {
      get(_target, prop) {
        const name = String(prop);
        accessed.add(name);
        const table = tables[name];
        if (table === undefined) {
          throw new Error(`cross-class failure: unexpected prisma table access "${name}"`);
        }
        return table;
      },
    },
  );
  return { prisma: prisma as never, accessed };
}

function expectNoPlantedMaterial(serialized: string) {
  for (const secret of ALL_PLANTED) {
    expect(serialized).not.toContain(secret);
  }
}

describe("protected-handle sweep (029 T011, FR-003)", () => {
  // ------------------------------------------------------------------
  // 1. Composition options never leak material
  // ------------------------------------------------------------------
  it("api-key composition: engine options carry no raw key (api and worker)", async () => {
    const apiOptions = await seepientResolveEngineOptions(apikeyRequest(), deps);
    const workerOptions = await workerSeepientResolveEngineOptions(apikeyRequest(), deps);
    for (const options of [apiOptions, workerOptions]) {
      expectNoPlantedMaterial(JSON.stringify(options));
      // The key rides the per-run memory store, never the serialized options.
      expect((options.credentials as { isIsolated?: boolean }).isIsolated).toBe(true);
    }
  });

  it("api-key composition: resolved (non-request-borne) key stays out of the options too", async () => {
    const resolveModel = vi.fn(async () => ({
      id: "claude-sonnet-5",
      provider: "anthropic",
      apiKey: PLANTED_KEY,
    }));
    const options = await seepientResolveEngineOptions(
      { model: { provider: "anthropic", id: "claude-sonnet-5" }, resolveModel } as never,
      deps,
    );
    expect(resolveModel).toHaveBeenCalledExactlyOnceWith("anthropic", "claude-sonnet-5");
    expectNoPlantedMaterial(JSON.stringify(options));
  });

  it("model-oauth composition: durable adapter options carry no token material", async () => {
    const options = await seepientResolveEngineOptions(oauthRequest(), deps);
    expectNoPlantedMaterial(JSON.stringify(options));
    // Durable, product-backed — not the per-run memory store — and the rows
    // are read lazily (no prisma I/O happened: deps.prisma is a bare object).
    expect((options.credentials as { isIsolated?: boolean }).isIsolated).toBe(false);
  });

  // ------------------------------------------------------------------
  // 2. Executor env: shell commands get bot variables only
  // ------------------------------------------------------------------
  // The shell/computer executor builds the model-authored command's process
  // env exclusively through shellCommandEnvironment (executor.ts:4954/5024);
  // that inline assembly is a private run closure, so the nearest exported
  // seam is pinned here. Model keys resolve through resolveModelKey → the
  // per-run credential store — a path that never feeds commandEnvironment.
  it("shell command env never carries model credential material; only botSecret rows are read", async () => {
    const { prisma, accessed } = recordingPrisma({
      botSecret: { findMany: async () => [] },
    });
    const { env, unsetEnv } = await shellCommandEnvironment({
      prisma,
      secretStore: { load: vi.fn() },
      scope: { userId: "u1", spaceId: "s1", botId: "b1" },
      spaceEnvironment: { WORKSPACE: "default" },
      registerRedactions: () => {},
    });
    expectNoPlantedMaterial(JSON.stringify({ env, unsetEnv }));
    expect(env).toEqual({ WORKSPACE: "default" });
    // Cross-class: the command environment resolves ONLY bot command
    // variables — it never reads model secret rows or connector tables.
    expect([...accessed]).toEqual(["botSecret"]);
  });

  it("bot command variables that DO reach the env are registered for redaction in encoded forms", async () => {
    const botValue = `bot-var-${randomUUID()}`;
    const { env } = await shellCommandEnvironment({
      prisma: {
        botSecret: {
          findMany: async () => [
            {
              id: "bs-1",
              name: "API_TOKEN",
              auth: { type: "command" },
              ciphertext: "ct-1",
            },
          ],
        },
      } as never,
      secretStore: { load: async () => botValue },
      scope: { userId: "u1", spaceId: "s1", botId: "b1" },
      spaceEnvironment: {},
      registerRedactions: () => {},
    } as never) as { env: Record<string, string>; unsetEnv: string[] };
    expect(Object.values(env)).toEqual([botValue]);
    // The executor registers commandCredentialRedactions(env) into runSecrets
    // before the command runs (executor.ts:3448, 4954-4966) — assert the
    // registered forms cover the value so any echo is stripped.
    const registered = commandCredentialRedactions(env);
    expect(registered.length).toBeGreaterThan(0);
    // The executor registers the raw values AND these encoded forms together
    // in runSecrets (executor.ts:3446-3448), so every form is stripped.
    const runSecrets = [botValue, ...registered];
    for (const form of registered) {
      expect(redactSecrets(`echo ${form}`, runSecrets)).not.toContain(form);
    }
    expectNoPlantedMaterial(JSON.stringify(env));
  });

  // ------------------------------------------------------------------
  // 3. Tool-completion audit metadata is redacted
  // ------------------------------------------------------------------
  it("toolCompletionAuditPayload strips planted secrets from result details and errors", () => {
    const result = toolCompletionFromResult(
      { name: "web_fetch", executionId: `exec ${PLANTED_KEY}`, durationMs: 12 },
      {
        kind: "agent_tool_result",
        content: [{ type: "text", text: `fetched with ${PLANTED_KEY}` }],
        details: { frameId: `frame ${PLANTED_ACCESS}` },
      },
    );
    const payload = toolCompletionAuditPayload(result, ALL_PLANTED);
    expectNoPlantedMaterial(JSON.stringify(payload));
    // Metadata survives: content types only, never content.
    expect(payload.contentTypes).toEqual(["text"]);
    expect(payload.outcome).toBe("succeeded");

    const failed = toolCompletionAuditPayload(
      {
        name: "shell",
        executionId: "exec-2",
        durationMs: 5,
        error: new Error(`upstream rejected Bearer ${PLANTED_KEY}`),
      },
      ALL_PLANTED,
    );
    expectNoPlantedMaterial(JSON.stringify(failed));
    expect(failed.outcome).toBe("error");
  });

  // ------------------------------------------------------------------
  // 4. Product events: the enqueued payload is redacted
  // ------------------------------------------------------------------
  it("appendToolCompletionAudit enqueues an agent.tool.completed event without raw material", async () => {
    const append = vi.fn(async () => undefined);
    await appendToolCompletionAudit(
      { events: { append } },
      { spaceId: "s1", threadId: "t1", botId: "b1", runId: "r1" },
      toolCompletionFromResult(
        { name: "shell", executionId: "exec-3", durationMs: 3 },
        { content: [{ type: "text", text: `output containing ${PLANTED_KEY}` }] },
      ),
      ALL_PLANTED,
    );
    expect(append).toHaveBeenCalledTimes(1);
    const call = append.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.type).toBe("agent.tool.completed");
    expectNoPlantedMaterial(JSON.stringify(call));
  });

  // ------------------------------------------------------------------
  // 5. Streamed output: review args, activity lines, streaming deltas
  // ------------------------------------------------------------------
  // Boundary note: the engine adapter (src/transport/app/seepient-agent-runtime.ts:300)
  // passes tool results to the engine verbatim — "Result contents are redacted
  // by the app's hook, never here" — so the app-side contract is pinned on the
  // executor's exported redaction seams, plus the emitted-event shape having no
  // credential field (the runtime's event variants carry only
  // name/args/executionId, text deltas, progress text, usage, done.text).
  it("review args (progress/approval events) redact planted secrets, including sensitive keys", () => {
    const redacted = redactToolArgsForReview(
      {
        command: `curl -H 'Authorization: Bearer ${PLANTED_KEY}' https://example.test`,
        apiKey: PLANTED_KEY,
        nested: { token: PLANTED_ACCESS },
      },
      ALL_PLANTED,
    );
    expectNoPlantedMaterial(JSON.stringify(redacted));
    expect(redacted.apiKey).toBe("[redacted]");
  });

  it("activity lines (describeToolActivity) strip credential patterns without registered secrets", () => {
    const line = describeToolActivity("shell", {
      command: `echo ${PLANTED_KEY} && curl -H 'Authorization: Bearer ${PLANTED_ACCESS}'`,
    });
    expect(line).not.toContain(PLANTED_KEY);
    expect(line).not.toContain(PLANTED_ACCESS);
    expect(line).toContain("Bearer [redacted]");
  });

  it("streaming text deltas are redacted even when a secret is split across chunks", () => {
    const redactor = createStreamingRedactor([PLANTED_KEY]);
    const split = PLANTED_KEY.length - 4;
    const out = (redactor.push(`partial ${PLANTED_KEY.slice(0, split)}`) +
      redactor.push(`${PLANTED_KEY.slice(split)} done`)) as string;
    expectNoPlantedMaterial(out);
  });

  // ------------------------------------------------------------------
  // 6. Transcript: fail-closed guard before persistence
  // ------------------------------------------------------------------
  // The only path from completion blocks to transcript persistence runs
  // redactBlocks(completionBlocks, runSecrets) and then a containsSecret
  // guard that THROWS "refusing to persist a secret in the thread"
  // (executor.ts:7097-7105). redactBlocks is private (executor.ts:8150), so
  // the exported guard seam is pinned: anything containing material trips it,
  // and the redacted form passes it. Steps blocks carry only label/count
  // metadata (appendToolCallSegment), never tool content.
  it("containsSecret trips on planted material and passes on the redacted transcript form", () => {
    const raw = `final answer mentions ${PLANTED_KEY}`;
    expect(containsSecret(raw, ALL_PLANTED)).toBe(true);
    const redacted = redactSecrets(raw, ALL_PLANTED);
    expect(containsSecret(redacted, ALL_PLANTED)).toBe(false);
    expect(redacted).toBe("final answer mentions [redacted]");
    // Nested form the guard actually scans (arrays/objects, string + key).
    expect(
      containsSecret({ blocks: [{ kind: "text", text: raw }], [PLANTED_ACCESS]: "x" }, ALL_PLANTED),
    ).toBe(true);
  });

  // ------------------------------------------------------------------
  // 7. Cross-class negative: resolution paths are table/kind bound
  // ------------------------------------------------------------------
  it("model credential resolution queries only userModelCredential/spaceModelPreference — never connector or bot secret tables", async () => {
    const wheres: Record<string, unknown> = {};
    const { prisma, accessed } = recordingPrisma({
      spaceModelPreference: {
        findMany: async (args: { where: unknown }) => {
          wheres.spaceModelPreference = args.where;
          return [];
        },
      },
      userModelCredential: {
        findMany: async (args: { where: unknown }) => {
          wheres.userModelCredential = args.where;
          return [];
        },
      },
    });
    const credential = await findModelCredential(
      prisma,
      { userId: "u1", spaceId: "s1" } as never,
      "anthropic",
      "claude-sonnet-5",
    );
    expect(credential).toBeNull();
    expect([...accessed].sort()).toEqual(["spaceModelPreference", "userModelCredential"]);
    // Provider/scope-bound: the model kind filter rides every query, and the
    // scope is the user's own rows.
    expect(wheres.spaceModelPreference).toMatchObject({
      spaceId: "s1",
      userId: "u1",
      credential: { provider: "anthropic" },
    });
    expect(wheres.userModelCredential).toMatchObject({ userId: "u1", provider: "anthropic" });
  });

  it("the durable model store resolves only the exact model secret row (spaceId: null) and refuses other credential kinds", async () => {
    const wheres: unknown[] = [];
    const { prisma, accessed } = recordingPrisma({
      secret: {
        findFirst: async (args: { where: unknown }) => {
          wheres.push(args.where);
          return {
            id: "sec-9",
            ciphertext: serializeModelSecret({
              kind: "oauth",
              credential: toOAuthCredential({
                type: "oauth",
                access: PLANTED_ACCESS,
                refresh: PLANTED_REFRESH,
                expires: Date.now() + 60_000,
              }),
            }),
            createdAt: new Date(0),
          };
        },
      },
    });
    const store = new DurableModelCredentialStore({
      prisma,
      secretStore: { load: async (ciphertext: string) => ciphertext, put: async () => {} },
      scope: { userId: "u1", spaceId: "s1" },
      handle: { credentialId: "cred-1", secretId: "sec-9" },
      accountId: "seepients-app-model-key",
      provider: "anthropic",
    });
    // Kind binding: a non-model kind (e.g. a connector's account ref) cannot
    // resolve through the model store at all.
    await expect(store.resolve({ kind: "connector", id: "conn-1" })).rejects.toThrow(
      /CREDENTIAL_REQUIRED/,
    );
    const record = await store.getRecord("seepients-app-model-key");
    expect(record).toMatchObject({ kind: "oauth", access: PLANTED_ACCESS });
    expect([...accessed]).toEqual(["secret"]);
    // Table + fence binding: the model secret row namespace (userId owner,
    // spaceId: null, exact handle secretId) — connector material never lives here.
    expect(wheres).toEqual([{ id: "sec-9", userId: "u1", spaceId: null }]);
  });

  // ------------------------------------------------------------------
  // 8. Debug logs: credential-adjacent errors are sanitized first
  // ------------------------------------------------------------------
  // The executor's audit-failure and credential-adjacent logging paths pass
  // every message through sanitizeConnectorError + redactSecrets before
  // getLogger() (executor.ts:2797-2802).
  it("sanitizeConnectorError strips registered secrets and credential patterns from log messages", () => {
    const sanitized = sanitizeConnectorError(
      new Error(`upstream rejected Bearer ${PLANTED_KEY} (trace ${PLANTED_ACCESS})`),
      ALL_PLANTED,
    );
    expectNoPlantedMaterial(sanitized);
    // Pattern-based fallback even when the token was never registered.
    const unregistered = sanitizeConnectorError(
      new Error(`Authorization: Bearer ${PLANTED_REFRESH}`),
      [],
    );
    expect(unregistered).not.toContain(PLANTED_REFRESH);
    expect(unregistered).toContain("Bearer [redacted]");
  });
});
