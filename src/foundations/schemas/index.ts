/**
 * Foundations schema home (spec 010).
 *
 * All schemas are authored with standalone `typebox` (foundations never imports Pi).
 */
import Type from "typebox";

export { Type };

export * from "./inference.js";
export * from "./credential-store.js";
export * from "./provider-config.js";
