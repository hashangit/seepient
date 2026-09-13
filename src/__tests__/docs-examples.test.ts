import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as sdkExports from '../transport/sdk/index.js';
import { askSeepient } from '../transport/sdk/index.js';
import { createMockRuntime } from '../domain/__tests__/test-doubles.js';

const repoRoot = path.resolve(__dirname, '../..');
const docsSdkDir = path.join(repoRoot, 'docs/sdk');

const loadBearingPages = [
  'ask-seepient.md',
  'create-seepient.md',
  'skills.md',
  'multi-tenant.md',
  'stateless-workers.md',
  'migration.md',
];

describe('docs example import and runtime checks (FR-003)', () => {
  it('verifies all SDK imports in the 5 load-bearing SDK pages resolve (R10)', () => {
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
    const unexportedImports: string[] = [];

    for (const page of loadBearingPages) {
      const filePath = path.join(docsSdkDir, page);
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, 'utf8');

      // Match ```ts or ```typescript fences that don't have no-check
      const fenceRegex = /```(?:ts|typescript)(?:[^\n]*)\n([\s\S]*?)```/g;
      let match;
      while ((match = fenceRegex.exec(content)) !== null) {
        const fenceHeader = match[0].split('\n')[0];
        if (fenceHeader.includes('no-check')) continue;

        const code = match[1];
        const importRegex = /import\s+\{([^}]+)\}\s+from\s+['"]seepient['"]/g;
        let impMatch;
        while ((impMatch = importRegex.exec(code)) !== null) {
          const specifiers = impMatch[1]
            .split(',')
            .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
            .filter(Boolean);

          for (const spec of specifiers) {
            const cleanSpec = spec.replace(/^type\s+/, '');
            if (!knownSdkExports.has(cleanSpec)) {
              unexportedImports.push(`${page}: imported "${cleanSpec}" from "seepient" is not exported`);
            }
          }
        }
      }
    }

    if (unexportedImports.length > 0) {
      console.error('Docs example import errors:', unexportedImports);
    }
    expect(unexportedImports, 'Unexported SDK imports found in docs examples (R10)').toEqual([]);
  });

  it('runs the documented literal quickstart without throwing TENANCY_RUNTIME_REQUIRED (R19)', async () => {
    // Documented quickstart in docs/sdk/skills.md:100-107:
    // Calling askSeepient with skills literals must NOT trigger tenancy upgrade to multi
    // Today, this throws TENANCY_RUNTIME_REQUIRED because literals set skillSourcesInjected = true
    let error: any = null;
    try {
      await askSeepient('Summarize the latest report', {
        skills: [
          {
            name: 'summarize',
            content: '---\nname: summarize\ndescription: Summarize text succinctly\n---\nSummary instructions...',
          },
        ],
      });
    } catch (err: any) {
      error = err;
    }

    // Today this fails because error.code is 'TENANCY_RUNTIME_REQUIRED'
    expect(error?.code).not.toBe('TENANCY_RUNTIME_REQUIRED');
  });

  it('value-exports all SeepientError classes from SDK entry (FR-013)', () => {
    expect(sdkExports.SeepientError).toBeDefined();
    expect(sdkExports.ProviderError).toBeDefined();
    expect(sdkExports.AbortedError).toBeDefined();
    expect(sdkExports.ToolError).toBeDefined();
    expect(sdkExports.MaxStepsError).toBeDefined();
    expect(sdkExports.InferenceError).toBeDefined();
    expect(sdkExports.PermissionError).toBeDefined();
    expect(sdkExports.ApprovalBrokerError).toBeDefined();
    expect(sdkExports.AuditError).toBeDefined();
    expect(sdkExports.PolicyConflictError).toBeDefined();
    expect(sdkExports.PersistConfigInvalidError).toBeDefined();
    expect(sdkExports.SkillStoreUnavailableError).toBeDefined();
    expect(sdkExports.SkillCollisionError).toBeDefined();
    expect(new sdkExports.ProviderError('test', 'test')).toBeInstanceOf(sdkExports.SeepientError);
  });

  it('runs the documented flagship examples with consentMode under mock runtime (FR-015)', async () => {
    const prModule = await import('../domain/providers/provider-runtime.js');
    const mockRuntime = createMockRuntime([
      { content: 'Done updating package.json.' },
    ]);
    const spy = vi.spyOn(prModule, 'createAmbientProviderRuntime').mockReturnValue(mockRuntime);

    try {
      // Flagship example 1: ask-seepient.md:345
      const fileResult = await askSeepient("Read package.json and update the description field", {
        tools: ["core"],
        consentMode: "edit-enabled",
        cwd: repoRoot,
      });
      expect(fileResult.text).toBeDefined();

      // Flagship example 2: ask-seepient.md:394-400
      const mockRuntime2 = createMockRuntime([
        { content: 'All tests pass.' },
      ]);
      spy.mockReturnValue(mockRuntime2);

      const result = await askSeepient(
        "Run the test suite, find why test/auth.test.ts fails, and fix the implementation",
        {
          tools: ["execute_shell_command", "read_file", "edit_file"],
          consentMode: "edit-enabled",
          maxSteps: 8,
        },
      );
      expect(result.text).toBeDefined();
    } finally {
      spy.mockRestore();
    }
  });
});
