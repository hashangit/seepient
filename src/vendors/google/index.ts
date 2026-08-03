/**
 * Vendor quarantine — the only module allowed to import `@google/genai`.
 *
 * Spec 010 (Rev 4.3 / S0 spike). Google's current JS SDK drives direct Gemini
 * image generation (catalog-selected Gemini 3.1 image models, with
 * `gemini-2.5-flash-image` retained as a legacy member). Imported ONLY inside
 * `src/vendors/google/`; the import-boundary test enforces that no other layer
 * references `@google/genai`.
 *
 * Re-exports the stable Google surface used by the S0 spike and, later, by the
 * P3 raw wrappers (google-image-raw, google-discovery-source,
 * google-canonical-converter).
 */
export * from '@google/genai';
