/**
 * Zoe Channels — Voice transcription helper (spec 002 §9.2)
 *
 * Thin fail-safe adapter for inbound voice media. Idempotent + cached by media
 * hash so re-indexing won't thrash the upstream service (constitution V).
 *
 * No transcription provider ships in-tree (the repo has none today); the
 * default behaviour is a no-op that returns an empty string. Operators wire a
 * real transcription endpoint via `configureTranscription()` — the channels
 * binary can call it from settings, and future work can register a built-in.
 */

import { createHash } from "node:crypto";
import type { MediaAttachment } from "./types.js";

export type TranscribeFn = (media: MediaAttachment) => Promise<string>;

let configuredTranscribe: TranscribeFn | null = null;
const cache = new Map<string, string>();

/**
 * Install a transcription backend (e.g. a Whisper-compatible endpoint). When
 * unset, `transcribeVoice` returns an empty string (fail-safe).
 */
export function configureTranscription(fn: TranscribeFn | null): void {
  configuredTranscribe = fn;
}

/**
 * Transcribe a voice attachment. Returns the cached transcript for repeated
 * input, and an empty string when no backend is configured (fail-safe).
 */
export async function transcribeVoice(media: MediaAttachment): Promise<string> {
  if (!configuredTranscribe) return "";
  const key = hashMedia(media);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  try {
    const text = await configuredTranscribe(media);
    const result = text ?? "";
    cache.set(key, result);
    return result;
  } catch {
    // Fail safe — a transcription error must not drop the message.
    return "";
  }
}

/** Hash a media attachment for cache keying (by inline bytes or url). */
function hashMedia(media: MediaAttachment): string {
  if (media.data) {
    return createHash("sha256").update(media.data).digest("hex");
  }
  return createHash("sha256").update(media.url ?? "").digest("hex");
}
