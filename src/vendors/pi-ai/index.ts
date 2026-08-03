/**
 * Vendor quarantine — the only module allowed to import `@earendil-works/pi-ai`.
 *
 * Spec 010 (S0 spike). Pi is Seepient's adopted multi-provider inference bridge.
 * It is imported ONLY inside `src/vendors/pi-ai/`; the import-boundary test
 * (src/foundations/contracts/__tests__/architecture-boundaries.test.ts) enforces
 * that no other layer references `@earendil-works/pi-ai`. Foundations never
 * imports Pi — Foundations imports the standalone `typebox` package directly.
 *
 * Re-exports the stable Pi surface used by the S0 spike and, later, by the
 * P3 raw wrappers (pi-language-raw, pi-image-raw, pi-catalog-source,
 * pi-discovery-source, pi-canonical-converter). Stable-export list recorded
 * in `research.md` §"Probe results".
 */
export * from '@earendil-works/pi-ai';
