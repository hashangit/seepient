/**
 * Server unhandledRejection guard test suite (Spec 022-2 / T044 / VULN-24).
 *
 * Verifies that runSeepientServer attaches an unhandledRejection listener on startup
 * and detaches it on dispose so floating background rejections do not crash the host process.
 */

import { describe, it, expect } from "vitest";
import { runSeepientServer } from "../index.js";

describe("Server unhandledRejection Guard (T044 / VULN-24)", () => {
  it("attaches unhandledRejection handler on server startup and detaches on dispose", async () => {
    const initialListeners = process.listeners("unhandledRejection");
    const server = await runSeepientServer({ listen: false });

    const currentListeners = process.listeners("unhandledRejection");
    expect(currentListeners.length).toBe(initialListeners.length + 1);

    // Dispose server
    server.dispose();
    const finalListeners = process.listeners("unhandledRejection");
    expect(finalListeners.length).toBe(initialListeners.length);
  });
});
