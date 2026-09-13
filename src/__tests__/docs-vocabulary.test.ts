import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import * as sdkExports from '../transport/sdk/index.js';
import * as serverExports from '../transport/http/index.js';
import { VALID_CONSENT_MODES } from '../foundations/config.js';
import { SERVER_CLI_FLAGS } from '../transport/cli/server-cli.js';

interface DocsVocabularyReport {
  consentModes: string[];
  envVars: string[];
  cliFlags: string[];
  subcommands: string[];
  sdkImports: string[];
}

function getAllMarkdownFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getAllMarkdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(fullPath);
    }
  }
  return files;
}

const repoRoot = path.resolve(__dirname, '../..');
const docsDir = path.join(repoRoot, 'docs');
const readmePath = path.join(repoRoot, 'README.md');
const envExamplePath = path.join(repoRoot, '.env.example');

const allMdFiles = [...getAllMarkdownFiles(docsDir), readmePath];

describe('docs vocabulary gate (FR-002)', () => {
  it('checks 1-5: consent modes, env vars, CLI flags, subcommands, and SDK imports match code truth', async () => {
    const report: DocsVocabularyReport = {
      consentModes: [],
      envVars: [],
      cliFlags: [],
      subcommands: [],
      sdkImports: [],
    };

    // 1. Consent-mode vocabulary
    // Real set: ask-everything, edit-enabled, autonomous
    // Banned set (CB-3): always-ask, ask-untrusted, autonomous-trusted
    const bannedConsentTokens = ['always-ask', 'ask-untrusted', 'autonomous-trusted'];
    for (const file of allMdFiles) {
      const relPath = path.relative(repoRoot, file);
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const banned of bannedConsentTokens) {
          if (line.includes(banned)) {
            report.consentModes.push(`${relPath}:${i + 1} uses banned consent mode "${banned}"`);
          }
        }
      }
    }

    // 2. Env vars
    // Every SEEPIENT_[A-Z0-9_]+ in docs, README, .env.example must appear as an exact token in src/
    // SEEPIENT_SHELL_APPROVE is banned outright (CB-3)
    const envScanFiles = [...allMdFiles, envExamplePath];
    const srcFiles: string[] = [];
    function scanSrc(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanSrc(p);
        } else if (/\.(ts|tsx|js|mjs|json)$/.test(entry.name)) {
          srcFiles.push(p);
        }
      }
    }
    scanSrc(path.join(repoRoot, 'src'));

    const knownSrcEnvVars = new Set<string>();
    for (const file of srcFiles) {
      const content = fs.readFileSync(file, 'utf8');
      const matches = content.matchAll(/\b(SEEPIENT_[A-Z0-9_]+)\b/g);
      for (const m of matches) {
        knownSrcEnvVars.add(m[1]);
      }
    }

    // CB-3 grep ban: SEEPIENT_SHELL_APPROVE must not appear in src/
    for (const file of srcFiles) {
      if (file.endsWith('docs-vocabulary.test.ts')) continue;
      const content = fs.readFileSync(file, 'utf8');
      if (content.includes('SEEPIENT_SHELL_APPROVE')) {
        const relPath = path.relative(repoRoot, file);
        report.envVars.push(`${relPath} references banned env var SEEPIENT_SHELL_APPROVE`);
      }
    }

    for (const file of envScanFiles) {
      if (!fs.existsSync(file)) continue;
      const relPath = path.relative(repoRoot, file);
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes('SEEPIENT_SHELL_APPROVE')) {
          report.envVars.push(`${relPath}:${i + 1} references banned env var SEEPIENT_SHELL_APPROVE`);
        }
        const matches = line.matchAll(/\b(SEEPIENT_[A-Z0-9_]+)\b/g);
        for (const match of matches) {
          const varName = match[1];
          // Exact token check against tokens found in src/
          if (!knownSrcEnvVars.has(varName)) {
            report.envVars.push(`${relPath}:${i + 1} references unknown env var ${varName}`);
          }
        }
      }
    }

    // 3. CLI subcommands in headings vs Commander registered subcommands
    const { cliProgram } = await import('../ui/cli/index.js');
    const registeredSubcommands = new Set(cliProgram.commands.map((c: any) => c.name()));
    // "chat" is default; also help / version
    registeredSubcommands.add('chat');
    registeredSubcommands.add('help');

    for (const file of allMdFiles) {
      const relPath = path.relative(repoRoot, file);
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Match headings like "### `seepient foo`" or "### seepient foo"
        const subMatch = line.match(/^#{2,4}\s+[`]?seepient\s+([a-zA-Z0-9_-]+)[`]?/);
        if (subMatch) {
          const subcmd = subMatch[1];
          // Ignore placeholders like <subcommand> or prompt
          if (subcmd.startsWith('<') || subcmd === 'prompt' || subcmd === '[options]') continue;
          if (!registeredSubcommands.has(subcmd)) {
            report.subcommands.push(`${relPath}:${i + 1} documents non-existent subcommand "seepient ${subcmd}"`);
          }
        }
      }
    }

    // 4. CLI flags in flag tables vs Commander registered options
    const registeredFlags = new Set<string>();
    const { getRegisteredCliOptions } = await import('../ui/cli/index.js');
    const cliOpts = getRegisteredCliOptions();
    for (const opt of cliOpts) {
      if (opt.long) registeredFlags.add(opt.long);
      if (opt.short) registeredFlags.add(opt.short);
    }
    // Also include default Commander options
    registeredFlags.add('-V');
    registeredFlags.add('--version');
    registeredFlags.add('-h');
    registeredFlags.add('--help');

    // Server CLI flags from code truth
    const serverAllowedFlags = new Set<string>(SERVER_CLI_FLAGS);

    const cliTableFiles = [
      path.join(docsDir, 'cli/reference.md'),
      readmePath,
    ];

    for (const file of cliTableFiles) {
      if (!fs.existsSync(file)) continue;
      const relPath = path.relative(repoRoot, file);
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n');
      let inTable = false;
      let isServerTable = false;
      let hasShorthand = false;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes('seepient-server') || line.includes('Server binary')) {
          isServerTable = true;
        } else if (line.startsWith('## ') && !line.includes('Server')) {
          isServerTable = false;
        }
        if (line.trim().startsWith('|') && line.includes('Flag') && line.includes('Description')) {
          inTable = true;
          hasShorthand = line.includes('Shorthand');
          continue;
        }
        if (inTable) {
          if (!line.trim().startsWith('|')) {
            inTable = false;
            hasShorthand = false;
            continue;
          }
          if (line.includes('---')) continue;
          // Table row: extract flags only from flag column(s) (with or without backticks)
          const cells = line.split('|').slice(1, -1).map((c) => c.trim());
          if (cells.length > 0) {
            const flagCells = hasShorthand ? cells.slice(0, 2).join(' ') : cells[0];
            const flagMatches = flagCells.matchAll(/(?:`?)(-[a-zA-Z]|--[a-zA-Z0-9-]+)(?:`?)/g);
            for (const fm of flagMatches) {
              const flag = fm[1];
              const allowed = isServerTable
                ? serverAllowedFlags.has(flag)
                : registeredFlags.has(flag);
              if (!allowed) {
                report.cliFlags.push(`${relPath}:${i + 1} documents non-existent CLI flag ${flag}`);
              }
            }
          }
        }
      }
    }

    // 4. SDK imports
    // Named imports in fenced TS/JS blocks importing from "seepient" or "seepient/server"
    function extractExportNames(filePath: string): Set<string> {
      const content = fs.readFileSync(filePath, 'utf8');
      const names = new Set<string>();
      const exportBraceRegex = /export\s+(?:type\s+)?\{([^}]+)\}/g;
      let match;
      while ((match = exportBraceRegex.exec(content)) !== null) {
        const items = match[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop()!.trim()).filter(Boolean);
        for (const item of items) {
          const clean = item.replace(/^type\s+/, '').trim();
          if (clean) names.add(clean);
        }
      }
      const declRegex = /export\s+(?:declare\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|type|interface|enum)\s+([a-zA-Z0-9_$]+)/g;
      while ((match = declRegex.exec(content)) !== null) {
        names.add(match[1]);
      }
      return names;
    }

    const knownSdkExports = new Set([
      ...Object.keys(sdkExports),
      ...extractExportNames(path.join(repoRoot, 'src/transport/sdk/index.ts')),
    ]);
    const knownServerExports = new Set([
      ...Object.keys(serverExports),
      ...extractExportNames(path.join(repoRoot, 'src/transport/http/index.ts')),
    ]);

    for (const file of allMdFiles) {
      const relPath = path.relative(repoRoot, file);
      const content = fs.readFileSync(file, 'utf8');
      const fenceRegex = /```(?:ts|typescript|js|javascript)[^\n]*\n([\s\S]*?)```/g;
      let fenceMatch;
      while ((fenceMatch = fenceRegex.exec(content)) !== null) {
        const code = fenceMatch[1];
        // match import { ... } from 'seepient' or 'seepient/server'
        const importRegex = /import\s+\{([^}]+)\}\s+from\s+['"](seepient(?:\/server)?)['"]/g;
        let impMatch;
        while ((impMatch = importRegex.exec(code)) !== null) {
          const specifiers = impMatch[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
          const pkg = impMatch[2];
          const exportSet = pkg === 'seepient/server' ? knownServerExports : knownSdkExports;
          for (const spec of specifiers) {
            // If spec is a type import like `type Foo`, strip `type `
            const cleanSpec = spec.replace(/^type\s+/, '');
            if (!exportSet.has(cleanSpec)) {
              report.sdkImports.push(`${relPath} imports unexported identifier "${cleanSpec}" from "${pkg}"`);
            }
          }
        }
      }
    }

    // Print violations report
    if (
      report.consentModes.length > 0 ||
      report.envVars.length > 0 ||
      report.cliFlags.length > 0 ||
      report.subcommands.length > 0 ||
      report.sdkImports.length > 0
    ) {
      console.error('Docs Vocabulary Report Violations:');
      console.error(JSON.stringify(report, null, 2));
    }

    expect(report.consentModes, 'Consent mode violations (R1)').toEqual([]);
    expect(report.envVars, 'Env var violations (R8, R14)').toEqual([]);
    expect(report.cliFlags, 'CLI flag violations (R3)').toEqual([]);
    expect(report.subcommands, 'CLI subcommand violations').toEqual([]);
    expect(report.sdkImports, 'SDK import violations (R9, R10)').toEqual([]);
  });

  it('check 6: multi-tenant vocabulary and guarantees in docs/sdk/multi-tenant.md (FR-019)', () => {
    const multiTenantDoc = path.join(docsDir, 'sdk/multi-tenant.md');
    expect(fs.existsSync(multiTenantDoc)).toBe(true);
    const content = fs.readFileSync(multiTenantDoc, 'utf8');

    // New required identifiers (FR-019)
    const requiredIdentifiers = [
      'CREDENTIAL_REQUIRED',
      'TENANCY_WORKSPACE_REQUIRED',
      'createAmbientProviderRuntime',
      'createTenantAgent',
    ];

    for (const id of requiredIdentifiers) {
      expect(content, `multi-tenant.md must document identifier ${id}`).toContain(id);
    }

    // Every claim in the guarantees table must name an existing test file in the repo
    const claimMatches = content.matchAll(/\|\s*`([^`]+\.test\.ts)`\s*\|/g);
    const verifiedSuites: string[] = [];
    for (const m of claimMatches) {
      const testPath = path.join(repoRoot, m[1]);
      expect(fs.existsSync(testPath), `Claimed test file ${m[1]} must exist on disk`).toBe(true);
      verifiedSuites.push(m[1]);
    }
    expect(verifiedSuites.length).toBeGreaterThanOrEqual(10);
  });

  it('check 7: banned-identifier sweep — deleted exports and fictions must not appear anywhere in docs/, README, CHANGELOG, or examples (FR-015, FR-031, FR-034)', () => {
    const bannedIdentifiers = [
      'getDefaultProviderRuntime',
      'TENANCY_EDGE_VALIDATION_FAILED',
      'seepient/types',
    ];

    const violations: string[] = [];
    const filesToScan = [
      ...getAllMarkdownFiles(docsDir),
      readmePath,
      path.join(repoRoot, 'CHANGELOG.md'),
      ...getAllMarkdownFiles(path.join(repoRoot, 'examples')),
    ];

    for (const file of filesToScan) {
      if (!fs.existsSync(file)) continue;
      const relPath = path.relative(repoRoot, file);
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const banned of bannedIdentifiers) {
          if (line.includes(banned)) {
            violations.push(`${relPath}:${i + 1} contains banned identifier "${banned}"`);
          }
        }
      }
    }

    expect(violations, 'Banned identifier violations (FR-015, FR-031, FR-034)').toEqual([]);
  });
});
