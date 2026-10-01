/**
 * J9 Adversarial Journey — VULN-22: Unvalidated tools array at chat edges.
 *
 * Verifies that REST (/v1/chat) and WS validate the `tools` field at the edge:
 * only string[] is accepted; non-string items (objects, numbers, booleans)
 * or malformed types must return 400 Bad Request before model dispatch.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runSeepientServer } from "../index.js";
import { generateApiKey } from "../../auth/auth.js";
import { createSecurityGuard } from "../../../domain/permissions/__tests__/composition-closure/_guard.js";
import type { Server } from "node:http";

describe("J9 Tools Edge Validation Journey (VULN-22)", () => {
  let runningServer: Server | null = null;
  let serverPort = 0;
  let validApiKey = "";
  let guard = createSecurityGuard("VULN-22");

  beforeEach(async () => {
    guard = createSecurityGuard("VULN-22");
    const keyEntry = generateApiKey(["agent:run"]);
    validApiKey = keyEntry.rawKey;

    const result = await runSeepientServer({
      port: 0,
      host: "127.0.0.1",
    });
    runningServer = (result.server as Server) ?? null;
    if (runningServer) {
      const addr = runningServer.address();
      if (typeof addr === "object" && addr) {
        serverPort = addr.port;
      }
    }
  });

  afterEach(async () => {
    if (runningServer) {
      await new Promise<void>((resolve) => runningServer!.close(() => resolve()));
      runningServer = null;
    }
  });

  it("REST /v1/chat rejects non-string tools entries with 400 BAD_REQUEST", async () => {
    const invalidToolPayloads = [
      { tools: [123, 456] }, // numbers
      { tools: [{ name: "injection_tool" }] }, // objects
      { tools: [null] }, // nulls
      { tools: "not-an-array" }, // string instead of array
    ];

    const instrumentedFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await fetch(input, init);
      if (res.status === 400) {
        guard.recordHit("rest.invalidTools.400");
      }
      return res;
    };

    for (const payload of invalidToolPayloads) {
      const res = await instrumentedFetch(`http://127.0.0.1:${serverPort}/v1/chat`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${validApiKey}`,
        },
        body: JSON.stringify({
          message: "test invalid tools",
          ...payload,
        }),
      });

      // Fixed: 400 BAD_REQUEST with message indicating tools must be array of strings
      // Baseline: attempts execution or returns 500 / passes to model
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error?.message || data.message).toMatch(/tools/i);
    }

    guard.assertGuardedPathExecuted(invalidToolPayloads.length);
  });
});
