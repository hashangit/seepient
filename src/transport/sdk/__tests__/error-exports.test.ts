/**
 * SDK barrel error-export pin (R3, pass-10 P2-13): the typed error classes
 * named in the CHANGELOG are actually importable from the package barrel.
 */
import { describe, it, expect } from "vitest";
import {
  GlobalLifetimeForbiddenError,
  PathEscapesWorkspaceError,
  PathHardlinkRefusedError,
  PathIdentityMismatchError,
} from "../index.js";

describe("SDK barrel exports the R3 typed error classes", () => {
  it("all four are constructors carrying their machine-readable codes", () => {
    expect(new GlobalLifetimeForbiddenError().code).toBe("GLOBAL_LIFETIME_FORBIDDEN");
    expect(new PathEscapesWorkspaceError("/x").code).toBe("PATH_ESCAPES_WORKSPACE");
    expect(new PathHardlinkRefusedError("/x").code).toBe("PATH_HARDLINK_REFUSED");
    expect(new PathIdentityMismatchError("/x").code).toBe("PATH_IDENTITY_MISMATCH");
  });

  it("PATH_ESCAPES_WORKSPACE message does not echo the resolved host path (oracle fix)", () => {
    const err = new PathEscapesWorkspaceError("/private/etc/passwd");
    expect(err.message).not.toContain("/private/etc/passwd");
    expect(err.resolvedPath).toBe("/private/etc/passwd"); // programmatic field survives for logging
  });
});
