/**
 * Reference DbSkillSource (Spec 021-1, FR-009, QS-S3).
 *
 * Demonstrates a remote database-backed SkillSource for multi-tenant workers.
 * Queries global skills (tenant_id is null) or tenant-specific skills (= $1)
 * from the embedder control plane.
 */

import type { SkillSource, SkillRecord } from "../../../src/transport/sdk/index.js";
import { ControlPlaneTokenRequiredError } from "./worker.js";

export interface DbSkillSourceOptions {
  tenantId?: string;
  token?: string;
  controlPlaneToken?: string;
}

export class DbSkillSource implements SkillSource {
  private readonly baseUrl: string;
  private readonly tenantId?: string;
  private readonly token: string;

  constructor(
    baseUrl: string,
    tenantIdOrOpts?: string | DbSkillSourceOptions,
    token?: string,
  ) {
    if (!baseUrl) {
      throw new Error("[db-skill-source] baseUrl is required");
    }
    this.baseUrl = baseUrl;
    let resolvedToken: string | undefined;
    if (typeof tenantIdOrOpts === "object" && tenantIdOrOpts !== null) {
      this.tenantId = tenantIdOrOpts.tenantId;
      resolvedToken = tenantIdOrOpts.controlPlaneToken ?? tenantIdOrOpts.token;
    } else {
      this.tenantId = tenantIdOrOpts;
      resolvedToken = token;
    }
    if (!resolvedToken || resolvedToken.trim().length === 0) {
      throw new ControlPlaneTokenRequiredError("[db-skill-source] controlPlaneToken is required");
    }
    this.token = resolvedToken;
  }

  async list(): Promise<SkillRecord[]> {
    const url = this.tenantId
      ? `${this.baseUrl}/api/skills?tenantId=${encodeURIComponent(this.tenantId)}`
      : `${this.baseUrl}/api/skills`;

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });
    if (!res.ok) {
      throw new Error(`[db-skill-source] Failed to fetch skills: HTTP ${res.status}`);
    }

    const data = (await res.json()) as { skills: SkillRecord[] };
    return data.skills ?? [];
  }
}
