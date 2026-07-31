/**
 * Seepient Gateway — Settings Adapter
 *
 * Dedicated storage for gateway targets, credentials, and routes.
 * Bypasses the static SettingsManager SETTINGS_MAP which rejects dynamic keys.
 * Uses atomic writes (temp file + rename) matching existing Seepient patterns.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { Target } from './types.js';

export class GatewaySettingsAdapter {
  private targetsPath: string;
  private credentialsPath: string;
  private routesPath: string;
  private adminTargetsPath: string;

  private cachedTargets: Record<string, Target> = {};
  private cachedCredentials: Record<string, string> = {};
  private cachedRoutes: Array<{ pattern: string; target: string; priority: number }> = [];
  private cachedAdminTargets: Set<string> = new Set();

  constructor(storageDir: string) {
    const base = process.env.SEEPIENT_GATEWAY_DIR ?? path.join(storageDir, 'gateway');
    this.targetsPath = path.join(base, 'targets.json');
    this.credentialsPath = path.join(base, 'credentials.json');
    this.routesPath = path.join(base, 'routes.json');
    this.adminTargetsPath = path.join(base, 'admin-targets.json');
  }

  async initialize(): Promise<void> {
    await Promise.all([
      this.loadTargets(),
      this.loadCredentials(),
      this.loadRoutes(),
      this.loadAdminTargets(),
    ]);
  }

  // ── Targets ───────────────────────────────────────────────────────────

  async loadTargets(): Promise<Record<string, Target>> {
    try {
      const data = await fs.readFile(this.targetsPath, 'utf-8');
      this.cachedTargets = JSON.parse(data) as Record<string, Target>;
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
      this.cachedTargets = {};
    }
    return this.cachedTargets;
  }

  async saveTarget(name: string, target: Target): Promise<void> {
    this.cachedTargets[name] = target;
    await this.atomicWrite(this.targetsPath, JSON.stringify(this.cachedTargets, null, 2));
  }

  async deleteTarget(name: string): Promise<void> {
    delete this.cachedTargets[name];
    await this.atomicWrite(this.targetsPath, JSON.stringify(this.cachedTargets, null, 2));
  }

  getTargets(): Record<string, Target> {
    return this.cachedTargets;
  }

  // ── Credentials ───────────────────────────────────────────────────────

  async loadCredentials(): Promise<Record<string, string>> {
    try {
      const data = await fs.readFile(this.credentialsPath, 'utf-8');
      this.cachedCredentials = JSON.parse(data) as Record<string, string>;
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
      this.cachedCredentials = {};
    }
    return this.cachedCredentials;
  }

  getCredential(key: string): string | undefined {
    return this.cachedCredentials[key];
  }

  async setCredential(key: string, value: string): Promise<void> {
    this.cachedCredentials[key] = value;
    await this.atomicWrite(this.credentialsPath, JSON.stringify(this.cachedCredentials, null, 2), 0o600);
  }

  async deleteCredential(key: string): Promise<void> {
    delete this.cachedCredentials[key];
    await this.atomicWrite(this.credentialsPath, JSON.stringify(this.cachedCredentials, null, 2), 0o600);
  }

  listCredentialKeys(): string[] {
    return Object.keys(this.cachedCredentials);
  }

  // ── Routes ────────────────────────────────────────────────────────────

  async loadRoutes(): Promise<Array<{ pattern: string; target: string; priority: number }>> {
    try {
      const data = await fs.readFile(this.routesPath, 'utf-8');
      this.cachedRoutes = JSON.parse(data) as Array<{ pattern: string; target: string; priority: number }>;
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
      this.cachedRoutes = [];
    }
    return this.cachedRoutes;
  }

  async saveRoutes(routes: Array<{ pattern: string; target: string; priority: number }>): Promise<void> {
    this.cachedRoutes = routes;
    await this.atomicWrite(this.routesPath, JSON.stringify(routes, null, 2));
  }

  getRoutes(): Array<{ pattern: string; target: string; priority: number }> {
    return this.cachedRoutes;
  }

  // ── Admin targets ────────────────────────────────────────────────────

  async loadAdminTargets(): Promise<Set<string>> {
    try {
      const data = await fs.readFile(this.adminTargetsPath, 'utf-8');
      const arr = JSON.parse(data) as string[];
      this.cachedAdminTargets = new Set(arr);
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
      this.cachedAdminTargets = new Set();
    }
    return this.cachedAdminTargets;
  }

  getAdminTargets(): Set<string> {
    return this.cachedAdminTargets;
  }

  async addAdminTarget(name: string): Promise<void> {
    this.cachedAdminTargets.add(name);
    await this.atomicWrite(this.adminTargetsPath, JSON.stringify([...this.cachedAdminTargets], null, 2));
  }

  async removeAdminTarget(name: string): Promise<void> {
    this.cachedAdminTargets.delete(name);
    await this.atomicWrite(this.adminTargetsPath, JSON.stringify([...this.cachedAdminTargets], null, 2));
  }

  // ── Atomic write ──────────────────────────────────────────────────────

  private async atomicWrite(filePath: string, content: string, mode?: number): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.tmp`;
    await fs.writeFile(tempPath, content, mode ? { mode } : undefined);
    await fs.rename(tempPath, filePath);
  }
}
