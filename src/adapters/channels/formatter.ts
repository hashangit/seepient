/**
 * Zoe Channels — Outbound formatter (spec 002 §5.2 / §6.3)
 *
 * Platform-aware outbound shaping: chunk long text to per-platform limits and
 * strip Markdown for platforms that don't render it. Data-driven — a single
 * per-platform config object drives behaviour. No speculative abstraction
 * (constitution III).
 */

import type { ChannelPlatform, ConversationType } from "../../core/types.js";
import type { OutboundPayload } from "./types.js";

interface PlatformFormat {
  /** Max characters per outbound message chunk. */
  maxChars: number;
  /** Whether the platform renders Markdown natively. */
  supportsMarkdown: boolean;
}

const PLATFORM_FORMAT: Partial<Record<ChannelPlatform, PlatformFormat>> = {
  telegram: { maxChars: 4096, supportsMarkdown: true },
  discord: { maxChars: 2000, supportsMarkdown: true },
  slack: { maxChars: 40000, supportsMarkdown: true },
  whatsapp: { maxChars: 4096, supportsMarkdown: false },
  teams: { maxChars: 4096, supportsMarkdown: true },
  // Runtime adapters don't go through the formatter, but define a sane default.
  cli: { maxChars: Number.MAX_SAFE_INTEGER, supportsMarkdown: true },
  sdk: { maxChars: Number.MAX_SAFE_INTEGER, supportsMarkdown: true },
  server: { maxChars: Number.MAX_SAFE_INTEGER, supportsMarkdown: true },
};

const DEFAULT_FORMAT: PlatformFormat = { maxChars: 4096, supportsMarkdown: true };

function formatFor(platform: ChannelPlatform): PlatformFormat {
  return PLATFORM_FORMAT[platform] ?? DEFAULT_FORMAT;
}

/**
 * Strip Markdown to plain text. Conservative — targets the common inline
 * syntaxes (**bold**, *italic*, `code`, [link](url)) and fenced code blocks.
 * Platforms without Markdown (WhatsApp) get the cleaned text.
 */
export function stripMarkdown(text: string): string {
  return text
    // Fenced code blocks → keep contents, drop the fences
    .replace(/```[\w]*\n?([\s\S]*?)```/g, "$1")
    // Inline code
    .replace(/`([^`]+)`/g, "$1")
    // Bold + italic (**, __, *, _)
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    // Links [text](url) → text
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    // Headers (## ) → plain
    .replace(/^#{1,6}\s+/gm, "")
    // Strikethrough
    .replace(/~~([^~]+)~~/g, "$1");
}

/**
 * Split text into chunks no longer than `maxChars`, preferring to break on
 * newlines and sentence boundaries rather than mid-word.
 */
export function chunkText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    // Look for a nice break point at or before the limit.
    let cut = remaining.lastIndexOf("\n", maxChars);
    if (cut <= 0) cut = remaining.lastIndexOf(". ", maxChars);
    if (cut <= 0) cut = remaining.lastIndexOf(" ", maxChars);
    if (cut <= 0) cut = maxChars;
    // Slice up to the break (exclusive) so we never exceed maxChars.
    const take = Math.min(cut, maxChars);
    chunks.push(remaining.slice(0, take).trimEnd());
    remaining = remaining.slice(take);
  }
  if (remaining.length > 0) chunks.push(remaining.trimEnd());
  return chunks;
}

/**
 * Format an outbound payload for a platform: optionally strip Markdown, then
 * chunk to the platform's limit. Returns one `OutboundPayload` per chunk
 * (media, if present, rides on the first chunk).
 */
export function formatForPlatform(
  platform: ChannelPlatform,
  text: string,
  _conversationType?: ConversationType,
): OutboundPayload[] {
  const fmt = formatFor(platform);
  const normalized = fmt.supportsMarkdown ? text : stripMarkdown(text);
  const chunks = chunkText(normalized, fmt.maxChars);
  return chunks.map((chunk, i) => ({ text: chunk }));
}
