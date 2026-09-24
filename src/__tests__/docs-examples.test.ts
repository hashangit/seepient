import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as sdkExports from '../transport/sdk/index.js';
import { askSeepient } from '../transport/sdk/index.js';
import { createMockRuntime } from '../domain/__tests__/test-doubles.js';

const repoRoot = path.resolve(__dirname, '../..');
const docsSdkDir = path.join(repoRoot, 'docs/sdk');

const loadBearingPages = [
  'docs/sdk/ask-seepient.md',
  'docs/sdk/create-seepient.md',
  'docs/sdk/skills.md',
  'docs/sdk/multi-tenant.md',
  'docs/sdk/stateless-workers.md',
  'docs/sdk/migration.md',
  'docs/sdk/session-persistence.md',
  'docs/sdk/provider-management.md',
  'docs/server/deployment.md',
];

describe('docs example import and runtime checks (FR-003)', () => {
  it('verifies all SDK imports in the load-bearing docs pages resolve (R10, FR-019)', () => {
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
      const filePath = path.join(repoRoot, page);
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
    expect(sdkExports.CredentialRequiredError).toBeDefined();
    expect(sdkExports.TenancyWorkspaceRequiredError).toBeDefined();
    expect(sdkExports.TenancyStoreIncompleteError).toBeDefined();
    expect(sdkExports.TenancyRuntimeRequiredError).toBeDefined();
    expect(sdkExports.PrincipalRequiredError).toBeDefined();
    expect(sdkExports.SessionIdInvalidError).toBeDefined();
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

  it('verifies the documented README worker and WS examples (FR-032, FR-034)', async () => {
    const { createSeepient } = sdkExports;
    const { InMemoryAuditStore, InMemoryPolicyStore, InMemoryCapabilityLedger } = await import(
      '../domain/permissions/in-memory-stores.js'
    );
    const { MemoryPersistenceBackend } = await import(
      '../domain/sessions/session-store.js'
    );

    const mockRuntime = createMockRuntime([{ content: 'Worker task finished' }]);
    (mockRuntime as any).isIsolated = true;

    const workerDir = path.join(repoRoot, 'tmp-worker-test');
    if (!fs.existsSync(workerDir)) fs.mkdirSync(workerDir, { recursive: true });

    try {
      const worker = await createSeepient({
        principalId: 'tenant-123',
        cwd: workerDir,
        runtime: mockRuntime,
        auditStore: new InMemoryAuditStore(),
        persist: new MemoryPersistenceBackend(),
        policyStore: new InMemoryPolicyStore(),
        capabilityLedger: new InMemoryCapabilityLedger(),
        consentMode: 'autonomous',
      });

      const result = await worker.chat('Analyze the error logs');
      expect(result.text).toBe('Worker task finished');
      await worker.dispose();

      // WS wire shape from README:518-523: chunk.type === 'text' && chunk.delta
      const mockWsEvent = {
        data: JSON.stringify({
          type: 'text',
          delta: 'partial response',
          serverMsgId: 'msg-1',
        }),
      };
      const chunk = JSON.parse(mockWsEvent.data);
      let output = '';
      if (chunk.type === 'text' && chunk.delta) {
        output += chunk.delta;
      }
      expect(output).toBe('partial response');
    } finally {
      if (fs.existsSync(workerDir)) fs.rmSync(workerDir, { recursive: true, force: true });
    }
  });

  it('verifies construction of snippets from the 5 first-hour docs pages (FR-019)', async () => {
    // 1. migration.md
    const credentialStore = new sdkExports.MemoryCredentialStore();
    await credentialStore.put("openai", {
      kind: "api_key",
      keyValue: "sk-tenant-key",
    });
    const tenantRuntime = sdkExports.createIsolatedProviderRuntime({ credentialStore });
    expect(tenantRuntime.isIsolated).toBe(true);

    const agentMigration = await sdkExports.createSeepient({
      tenancy: "multi",
      principalId: "tenant_1",
      cwd: repoRoot,
      runtime: tenantRuntime,
      auditStore: new sdkExports.InMemoryAuditStore(),
      policyStore: new sdkExports.InMemoryPolicyStore(),
      capabilityLedger: new sdkExports.InMemoryCapabilityLedger(),
      stateless: true,
    });
    expect(agentMigration).toBeDefined();
    await agentMigration.dispose();

    // 2. session-persistence.md
    const { MemoryPersistenceBackend } = await import('../domain/sessions/session-store.js');
    const agentPersist = await sdkExports.createSeepient({
      tenancy: "single",
      sessionId: "user-alice-session",
      persist: new MemoryPersistenceBackend(),
    });
    expect(agentPersist).toBeDefined();
    expect(agentPersist.sessionId).toBe("user-alice-session");
    await agentPersist.dispose();

    // 3. provider-management.md
    const agentProvider = await sdkExports.createSeepient({
      tenancy: "single",
      overlayFile: ":memory:",
      providers: {
        isolated_openai: {
          adapter: "pi-ai",
          upstreamProvider: "openai",
          credential: { kind: "env", name: "OPENAI_API_KEY" },
        },
      },
      modelAssignments: {
        text: {
          standard: { providerAccount: "isolated_openai", model: "gpt-5.4" },
        },
      },
    });
    expect(agentProvider).toBeDefined();
    await agentProvider.dispose();

    // 4. ask-seepient.md
    const mockRuntime = createMockRuntime([{ content: "Summary of invoice" }]);
    (mockRuntime as any).isIsolated = true;

    const askRes = await sdkExports.askSeepient("Summarize today's invoice", {
      tenancy: "multi",
      principalId: "tenant-acme",
      cwd: repoRoot,
      runtime: mockRuntime,
      auditStore: new sdkExports.InMemoryAuditStore(),
      policyStore: new sdkExports.InMemoryPolicyStore(),
      capabilityLedger: new sdkExports.InMemoryCapabilityLedger(),
      stateless: true,
    });
    expect(askRes.text).toBe("Summary of invoice");

    // 5. deployment.md
    const serverModule = await import('../transport/http/index.js');
    expect(serverModule.runSeepientServer).toBeDefined();
  });

  it('constructs the documented createSeepient persistence examples — bare persist throws PRINCIPAL_REQUIRED (docs truth)', async () => {
    // Source-level trap gate: every fenced snippet in create-seepient.md that
    // calls createSeepient with a persist option must pin tenancy: "single".
    // persist is a multi-upgrade signal; a bare example throws PRINCIPAL_REQUIRED.
    const createSeepientDoc = fs.readFileSync(path.join(docsSdkDir, 'create-seepient.md'), 'utf8');
    const fenceRegex = /```(?:ts|typescript)(?:[^\n]*)\n([\s\S]*?)```/g;
    const barePersistFences: string[] = [];
    let fenceMatch;
    while ((fenceMatch = fenceRegex.exec(createSeepientDoc)) !== null) {
      const code = fenceMatch[1];
      if (/createSeepient\s*\(/.test(code) && /\bpersist\s*:/.test(code) && !/tenancy\s*:/.test(code)) {
        const persistLine = code.split('\n').find((l) => l.includes('persist:'));
        barePersistFences.push(persistLine?.trim() ?? code.slice(0, 60));
      }
    }
    expect(barePersistFences, 'create-seepient.md persist examples must set tenancy: "single"').toEqual([]);

    // Executed constructions, one per documented variant (Session persistence
    // x3, registered redis config, backend instance). The redis config runs as
    // its in-memory equivalent (no redis server in CI); the tenancy field — the
    // trap class under test — stays exactly as documented.
    const persistDir = path.join(repoRoot, 'tmp-docs-persist-test');
    const constructed: Array<Awaited<ReturnType<typeof sdkExports.createSeepient>>> = [];
    try {
      // Option 1: path string
      constructed.push(await sdkExports.createSeepient({ tenancy: 'single', persist: persistDir }));
      // Option 2: in-memory config
      constructed.push(await sdkExports.createSeepient({ tenancy: 'single', persist: { type: 'memory' } }));
      // Option 3: explicit file config
      constructed.push(
        await sdkExports.createSeepient({ tenancy: 'single', persist: { type: 'file', path: persistDir } })
      );
      // Registered backend config (redis in docs; memory equivalent here)
      constructed.push(await sdkExports.createSeepient({ tenancy: 'single', persist: { type: 'memory' } }));
      // Backend instance passed directly
      constructed.push(
        await sdkExports.createSeepient({
          tenancy: 'single',
          persist: {
            __persistenceBackend: true as const,
            async save() {},
            async load() {
              return null;
            },
            async delete() {},
            async list() {
              return [];
            },
          },
        })
      );
      for (const agent of constructed) {
        expect(agent).toBeDefined();
      }
    } finally {
      for (const agent of constructed) {
        await agent.dispose();
      }
      if (fs.existsSync(persistDir)) fs.rmSync(persistDir, { recursive: true, force: true });
    }

    // Red-side pin: the documented-without-tenancy shape really does throw.
    // If this ever stops throwing, the tenancy contract changed and the docs
    // examples must be revisited alongside this gate.
    let bareError: any = null;
    try {
      await sdkExports.createSeepient({ persist: { type: 'memory' } });
    } catch (err: any) {
      bareError = err;
    }
    expect(bareError?.code).toBe('PRINCIPAL_REQUIRED');

    // README is outside loadBearingPages construction; assert the example shape
    // at the source level instead.
    const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
    const headingIdx = readme.indexOf('#### Session Persistence');
    expect(headingIdx, 'README Session Persistence section must exist').toBeGreaterThanOrEqual(0);
    const section = readme.slice(headingIdx, readme.indexOf('####', headingIdx + 1));
    const readmeFence = section.match(/```ts\n([\s\S]*?)```/);
    expect(readmeFence, 'README Session Persistence example must exist').not.toBeNull();
    expect(
      readmeFence![1],
      'README Session Persistence example must set tenancy (bare persist upgrades to multi and throws PRINCIPAL_REQUIRED)'
    ).toMatch(/tenancy\s*:\s*['"]single['"]/);
  });
});
