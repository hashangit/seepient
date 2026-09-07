/**
 * Reference DbSkillSource (Spec 021-1, FR-009, QS-S3).
 *
 * Demonstrates a remote database-backed SkillSource for multi-tenant workers.
 * Queries global skills (tenant_id is null) or tenant-specific skills (= $1)
 * from the embedder control plane.
 */

import type { SkillSource, SkillRecord } from "../../../src/transport/sdk/index.js";

export class DbSkillSource implements SkillSource {
  private readonly baseUrl: string;
  private readonly tenantId?: string;

  constructor(baseUrl: string, tenantId?: string) {
    if (!baseUrl) {
      throw new Error("[db-skill-source] baseUrl is required");
    }
    this.baseUrl = baseUrl;
    this.tenantId = tenantId;
  }

  async list(): Promise<SkillRecord[]> {
    const url = this.tenantId
      ? `${this.baseUrl}/api/skills?tenantId=${encodeURIComponent(this.tenantId)}`
      : `${this.baseUrl}/api/skills`;

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`[db-skill-source] Failed to fetch skills: HTTP ${res.status}`);
    }

    const data = (await res.json()) as { skills: SkillRecord[] };
    return data.skills ?? [];
  }
}
