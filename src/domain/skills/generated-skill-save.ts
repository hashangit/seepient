/**
 * Generated skill save path (Spec 021-1, FR-006, 016 coordination).
 *
 * Persists generated skills to an embedder-provided SkillStore.
 * Enforces Spec 016 semantics:
 *  - kind: "generated" stamp
 *  - collision refusal with guidance (unless replace: true)
 *  - version and changelog increments on replacement
 *  - save destination = last SkillStore in the effective source list (D13)
 *  - fail-closed with SKILL_STORE_UNAVAILABLE when no store is wired
 */

import type { SkillRecord, SkillSource, SkillStore } from "../../foundations/contracts/skill-source.js";
import { SkillStoreUnavailableError, SkillCollisionError } from "../../foundations/errors.js";

export { SkillStoreUnavailableError, SkillCollisionError };

export interface SaveGeneratedSkillParams {
  name: string;
  description: string;
  body?: string;
  content?: string;
  sources?: SkillSource[];
  replace?: boolean;
  changelogEntry?: string;
  origin?: string;
}

export interface SaveGeneratedSkillResult {
  saved: true;
  record: SkillRecord;
  store: SkillStore;
  version: number;
}

function extractYamlAndBody(raw: string): { yaml: string; body: string } {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("---")) {
    return { yaml: "", body: raw };
  }
  const endIdx = trimmed.indexOf("---", 3);
  if (endIdx === -1) {
    return { yaml: "", body: raw };
  }
  return {
    yaml: trimmed.slice(3, endIdx).trim(),
    body: trimmed.slice(endIdx + 3).trimStart(),
  };
}

function parseChangelog(yaml: string): string[] {
  const lines = yaml.split("\n");
  const changelog: string[] = [];
  let inChangelog = false;
  for (const line of lines) {
    if (/^changelog:\s*$/.test(line)) {
      inChangelog = true;
      continue;
    }
    if (inChangelog) {
      const match = line.match(/^\s*-\s*(.*)$/);
      if (match) {
        changelog.push(match[1].trim().replace(/^['"]|['"]$/g, ""));
      } else if (/^\w+:/.test(line)) {
        inChangelog = false;
      }
    }
  }
  return changelog;
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

  if (existingRecord) {
    if (!params.replace) {
      throw new SkillCollisionError(params.name, existingSourceLabel);
    }

    const { yaml } = extractYamlAndBody(existingRecord.content);

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

    // Parse existing changelog
    const prevChangelog = parseChangelog(yaml);
    changelog = [
      ...prevChangelog,
      params.changelogEntry ?? `Version ${version}`,
    ];
  }

  const body = params.body ?? (params.content ? extractYamlAndBody(params.content).body : "");

  const changelogBlock = changelog.map((c) => `  - ${c}`).join("\n");
  const content = [
    "---",
    `name: ${params.name}`,
    `description: ${params.description}`,
    "kind: generated",
    `version: ${version}`,
    `origin: ${origin}`,
    `created_at: ${createdAt}`,
    "changelog:",
    changelogBlock,
    "---",
    body,
  ].join("\n");

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
