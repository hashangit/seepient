/**
 * Foundations schema home (spec 010).
 *
 * S0 SPIKE: proves the standalone `typebox` package compiles under Seepient's
 * tsconfig when imported from Foundations (the lowest layer). Foundations never
 * imports Pi — Pi merely re-exports typebox internally; Foundations reaches it
 * directly so removing Pi later does not affect core schemas.
 *
 * ===========================================================================
 * CRITICAL S0 FINDING — standalone typebox API divergence (research.md)
 * ===========================================================================
 * The 010 contract docs (provider-config.md, credential-store.md, etc.) write
 * schemas in the `@sinclair/typebox@0.34` style:
 *     import { Type, type Static } from 'typebox';   // ← WRONG for standalone
 *     const S = Type.Object({ id: Type.String() });   // ← Type.String is a value here
 *     type T = Static<typeof S>;
 *
 * The actually-installed standalone `typebox@1.3.10` has a DIFFERENT API:
 *   1. DEFAULT import, not named:        `import Type from 'typebox'`
 *   2. Builders are CALLS, not values:   `Type.String()` not `Type.String`
 *   3. Static lives on the namespace:    `Type.Static<typeof S>` not `Static<typeof S>`
 *   4. Pi re-exports `{ Type } from 'typebox'` + `type { Static } from 'typebox'`,
 *      which only resolves because Pi's own d.ts bridges the names — importing
 *      typebox directly from Foundations does NOT get the @sinclair-style surface.
 *
 * P1 decision required (recorded in research.md, blocker for P1.1): either
 *   (a) adopt `typebox@1.x` canonical API (default import + call builders +
 *       `Type.Static<...>`), updating every contract example; OR
 *   (b) switch the dependency to `@sinclair/typebox@0.34` (the API the contracts
 *       already use; Pi 0.83 bundles typebox internally so this does not affect Pi).
 * This spike uses (a) to prove the standalone package itself compiles; the
 * contract-vs-package reconciliation is a P1.1 entry task.
 * ===========================================================================
 */
import Type from 'typebox';

/** Smoke schema — compiled away; proves the Foundations → typebox edge works. */
export const SpikeSchema = Type.Object({
  ok: Type.Boolean(),
  label: Type.Optional(Type.String()),
});

export type Spike = Type.Static<typeof SpikeSchema>;

/** Re-export the builder namespace P1 schemas will use, pinned to this module. */
export { Type };
