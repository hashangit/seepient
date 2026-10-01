/**
 * Generated skill save path (Spec 021-1, FR-006, 016 coordination).
 *
 * Persists generated skills to an embedder-provided SkillStore.
 * Enforces Spec 016 semantics:
 *  - kind: "generated" stamp
 *  - collision refusal with guidance (unless replace: true)
 *  - version and changelog increments on replacement
 *  - tags and allowedTools preservation or update
 *  - save destination = last SkillStore in the effective source list (D13)
 *  - fail-closed with SKILL_STORE_UNAVAILABLE when no store is wired
 */

import type { SkillRecord, SkillSource, SkillStore } from "../../foundations/contracts/skill-source.js";
import { SkillStoreUnavailableError, SkillCollisionError, SkillBodyRequiredError } from "../../foundations/errors.js";
import { splitFrontmatter } from "../../capabilities/skills/parser.js";

export { SkillStoreUnavailableError, SkillCollisionError, SkillBodyRequiredError };

const KNOWN_FRONTMATTER_KEYS = new Set([
  "name",
  "description",
  "kind",
  "version",
  "origin",
  "created_at",
  "tags",
  "allowedTools",
  "changelog",
]);

function extractUnknownYamlBlocks(yaml: string): string[] {
  const lines = yaml.split("\n");
  const unknownBlocks: string[] = [];
  let currentKey: string | null = null;
  let currentBlock: string[] = [];

  for (const line of lines) {
    const keyMatch = line.match(/^([a-zA-Z0-9_-]+):/);
    if (keyMatch) {
      if (currentKey && !KNOWN_FRONTMATTER_KEYS.has(currentKey)) {
        unknownBlocks.push(...currentBlock);
      }
      currentKey = keyMatch[1];
      currentBlock = [line];
    } else if (currentKey) {
      currentBlock.push(line);
    }
  }

  if (currentKey && !KNOWN_FRONTMATTER_KEYS.has(currentKey)) {
    unknownBlocks.push(...currentBlock);
  }

  return unknownBlocks;
}

export interface SaveGeneratedSkillParams {
  name: string;
  description: string;
  body?: string;
  content?: string;
  sources?: SkillSource[];
  replace?: boolean;
  changelogEntry?: string;
  origin?: string;
  tags?: string[];
  allowedTools?: string[];
}

export interface SaveGeneratedSkillResult {
  saved: true;
  record: SkillRecord;
  store: SkillStore;
  version: number;
}


function parseYamlList(yaml: string, fieldName: string): string[] {
  const inlineMatch = yaml.match(new RegExp(`^${fieldName}:\\s*\\[(.*)\\]`, "m"));
  if (inlineMatch) {
    return inlineMatch[1]
      .split(",")
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean);
  }
  const lines = yaml.split("\n");
  const items: string[] = [];
  let inList = false;
  for (const line of lines) {
    if (new RegExp(`^${fieldName}:\\s*$`).test(line)) {
      inList = true;
      continue;
    }
    if (inList) {
      const match = line.match(/^\s*-\s*(.*)$/);
      if (match) {
        items.push(match[1].trim().replace(/^['"]|['"]$/g, ""));
      } else if (/^\w+:/.test(line)) {
        inList = false;
      }
    }
  }
  return items;
}

function formatYamlScalar(key: string, value: string): string {
  if (value.includes("\n")) {
    const indented = value
      .split("\n")
      .map((l) => (l ? `  ${l}` : ""))
      .join("\n");
    return `${key}: |\n${indented}`;
  }
  if (/[:#\[\]{},"'\r]/.test(value) || /^\s|\s$/.test(value) || value === "") {
    return `${key}: ${JSON.stringify(value)}`;
  }
  return `${key}: ${value}`;
}

function formatYamlListItem(item: string): string {
  if (/[:#\[\]{},"'\n\r]/.test(item) || /^\s|\s$/.test(item) || item === "") {
    return `  - ${JSON.stringify(item)}`;
  }
  return `  - ${item}`;
}

/**
 * Save a generated skill to the last SkillStore in the effective sources list.
 * Fails closed if no SkillStore is available.
 */
export async function saveGeneratedSkill(
  params: SaveGeneratedSkillParams,
): Promise<SaveGeneratedSkillResult> {
  const sources = params.sources ?? [];
  const stores = sources.filter((s): s is SkillStore => typeof (s as any).save === "function");

  if (stores.length === 0) {
    throw new SkillStoreUnavailableError();
  }

  // D13: Save destination is the LAST store in the effective sources list
  const targetStore = stores[stores.length - 1];

  // Scan all sources for collision
  let existingRecord: SkillRecord | undefined;
  let existingSourceLabel: string | undefined;

  for (const src of sources) {
    try {
      const records = await src.list();
      const match = records.find((r) => r.name === params.name);
      if (match) {
        existingRecord = match;
        existingSourceLabel = match.source ?? "injected";
      }
    } catch {
      // Best-effort list across sources
    }
  }

  let version = 1;
  let createdAt = new Date().toISOString();
  let changelog: string[] = [params.changelogEntry ?? "Initial creation"];
  let origin = params.origin ?? "standalone";
  let prevTags: string[] | undefined;
  let prevAllowedTools: string[] | undefined;
  let unknownFrontmatterLines: string[] = [];

  if (existingRecord) {
    if (!params.replace) {
      throw new SkillCollisionError(params.name, existingSourceLabel);
    }

    const { yaml } = splitFrontmatter(existingRecord.content);

    // Extract any unknown frontmatter blocks to preserve verbatim (FR-036)
    unknownFrontmatterLines = extractUnknownYamlBlocks(yaml);

    // Parse existing version
    const vMatch = yaml.match(/^version:\s*(.+)$/m);
    if (vMatch) {
      const parsed = parseInt(vMatch[1].trim(), 10);
      if (!isNaN(parsed)) {
        version = parsed + 1;
      } else {
        version = 2;
      }
    } else {
      version = 2;
    }

    // Parse existing created_at
    const createdMatch = yaml.match(/^created_at:\s*(.+)$/m);
    if (createdMatch) {
      createdAt = createdMatch[1].trim().replace(/^['"]|['"]$/g, "");
    }

    // Parse existing origin
    const originMatch = yaml.match(/^origin:\s*(.+)$/m);
    if (originMatch) {
      origin = params.origin ?? originMatch[1].trim().replace(/^['"]|['"]$/g, "");
    }

    // Parse existing tags and allowedTools
    prevTags = parseYamlList(yaml, "tags");
    prevAllowedTools = parseYamlList(yaml, "allowedTools");

    // Parse existing changelog
    const prevChangelog = parseYamlList(yaml, "changelog");
    changelog = [
      ...prevChangelog,
      params.changelogEntry ?? `Version ${version}`,
    ];
  }

  const tags = params.tags ?? prevTags;
  const allowedTools = params.allowedTools ?? prevAllowedTools;
  const body = params.body ?? (params.content ? splitFrontmatter(params.content).body : "");

  // Guard against empty body (FR-036 / R54)
  if (!body || body.trim().length === 0) {
    throw new SkillBodyRequiredError(params.name);
  }

  const frontmatterLines: string[] = [
    "---",
    formatYamlScalar("name", params.name),
    formatYamlScalar("description", params.description),
    "kind: generated",
    `version: ${version}`,
    formatYamlScalar("origin", origin),
    `created_at: ${createdAt}`,
  ];

  if (tags && tags.length > 0) {
    frontmatterLines.push("tags:");
    for (const t of tags) {
      frontmatterLines.push(formatYamlListItem(t));
    }
  }

  if (allowedTools && allowedTools.length > 0) {
    frontmatterLines.push("allowedTools:");
    for (const tool of allowedTools) {
      frontmatterLines.push(formatYamlListItem(tool));
    }
  }

  if (unknownFrontmatterLines.length > 0) {
    frontmatterLines.push(...unknownFrontmatterLines);
  }

  frontmatterLines.push("changelog:");
  for (const c of changelog) {
    frontmatterLines.push(formatYamlListItem(c));
  }
  frontmatterLines.push("---");

  const content = `${frontmatterLines.join("\n")}\n${body}`;

  const record: SkillRecord = {
    name: params.name,
    content,
    source: existingSourceLabel ?? "generated",
  };

  await targetStore.save(record);

  return {
    saved: true,
    record,
    store: targetStore,
    version,
  };
}
