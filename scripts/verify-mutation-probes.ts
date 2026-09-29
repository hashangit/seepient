/**
 * Mutation Probe Matrix & Anti-Vacuity Verification Script (SC-004 / FR-018,
 * pass-10 P1-3 hardening).
 *
 * For every registered guard:
 *   1. GREEN BASELINE — the journey must pass un-neutralized. A permanently
 *      red journey would otherwise satisfy the probe for free.
 *   2. NEUTRALIZED RUN — the journey must turn red WITH EVIDENCE: the vitest
 *      summary must report at least one failed test. Spawn errors, missing
 *      binaries, "no test files found", and timeouts FAIL the probe; they are
 *      not "red" verdicts.
 *
 * Neutralization disables the guard at its PRODUCTION seam
 * (src/foundations/test-seams.ts, two-factor: NODE_ENV=test AND a vitest
 * worker), so a red verdict proves the guard is load-bearing for that journey.
 * A red verdict additionally requires the journey's EXPECTED SECURITY MESSAGE
 * to appear in the FAIL section (the failing tests' names and assertion
 * output) — an unrelated failure, or a marker echoed only by a passing
 * test's stdout, is not evidence. Alternation markers ("A|B") match any
 * alternative in the FAIL section.
 *
 * The matrix enforces its own wiring BEFORE running journeys (022-5-WO1
 * T018/T019; rules live in src/foundations/probe-matrix.ts, pinned by
 * src/foundations/__tests__/probe-self-integrity.test.ts):
 *   - SEAM COVERAGE: every registered guardId must have >= 1 production
 *     isGuardNeutralized("<id>") call site, and every production seam id must
 *     be registered. Since the journeys' ZERO_HITS counter no longer reads
 *     NEUTRALIZE_* (022-5 de-confound), a deleted production seam leaves its
 *     journey green under neutralization and the probe FAILS — the lint
 *     catches the same condition before the slow runs. The committed dogfood
 *     pins (probe-self-integrity.test.ts) prove the lint rejects a
 *     deleted-seam registration.
 *   - REGISTRATION: every journey importing createSecurityGuard must appear
 *     in PROBE_TARGETS or in COUNTER_ONLY_JOURNEYS (journeys whose guard is
 *     an anti-vacuity counter with no production seam to mutate).
 *
 * Usage:
 *   pnpm tsx scripts/verify-mutation-probes.ts
 */

import { spawnSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  assertJourneyRegistration as assertJourneyRegistrationPure,
  assertSeamCoverage as assertSeamCoveragePure,
  extractFailSection,
  markerMatches,
} from "../src/foundations/probe-matrix.js";

interface ProbeTarget {
  guardId: string;
  description: string;
  testFile: string;
  neutralizeEnv: string;
  /** Marker that must appear in the neutralized failure output — the
   *  journey's security assertion, not just any failed test. */
  expectedMessage: string;
}

/** Journeys that use createSecurityGuard as an anti-vacuity counter but have
 *  no production seam to neutralize. Every guard-using journey must appear
 *  here or in PROBE_TARGETS — nothing escapes the register silently. */
const COUNTER_ONLY_JOURNEYS: { testFile: string; reason: string }[] = [
  {
    testFile: "src/domain/permissions/__tests__/composition-closure/identity-validation.test.ts",
    reason: "VULN-2 counter: the identity validator denies by construction; no seam to mutate",
  },
  {
    testFile: "src/transport/http/__tests__/session-partition.test.ts",
    reason: "VULN-3 counter: session lookup keys are structural, not a branch to disable",
  },
  {
    testFile: "src/transport/http/__tests__/tools-edge.test.ts",
    reason: "VULN-22 counter: tools-edge validation is an allowlist, not a removable branch",
  },
  {
    testFile: "src/vendors/pi-ai/__tests__/inference-fail-closed.test.ts",
    reason: "drives PiLanguageRaw directly (not agent-loop), so the VULN-16 producer seam in agent-loop does not apply; the armed-journey target covers that seam",
  },
];

const SPAWN_TIMEOUT_MS = 180_000;

const PROBE_TARGETS: ProbeTarget[] = [
  {
    guardId: "VULN-1",
    description: "EffectBroker multi-mode ambient-secret fail-closed (resolveSecret)",
    testFile: "src/domain/permissions/__tests__/composition-closure/tenant-secret-journey.test.ts",
    neutralizeEnv: "NEUTRALIZE_VULN_1",
    expectedMessage: "does not leak host env",
  },
  {
    guardId: "VULN-1-BROKER",
    description: "EffectBroker multi-mode ambient process.env key exfiltration",
    testFile: "src/domain/permissions/__tests__/composition-closure/exfil-journey.test.ts",
    neutralizeEnv: "NEUTRALIZE_VULN_1",
    expectedMessage: "fails closed with CREDENTIAL_REQUIRED on unresolved secretRef",
  },
  {
    guardId: "VULN-5",
    description: "InMemoryReplayLedger default in multi (brokered zero-disk-write)",
    testFile: "src/domain/permissions/__tests__/composition-closure/zero-write-brokered.test.ts",
    neutralizeEnv: "NEUTRALIZE_VULN_5",
    expectedMessage: "performs zero writes under $HOME/.seepient",
  },
  {
    guardId: "VULN-9",
    description: "Server multi-mode in-memory store defaults (isolated boot zero-write)",
    testFile: "src/transport/http/__tests__/isolated-boot.test.ts",
    neutralizeEnv: "NEUTRALIZE_VULN_9",
    expectedMessage: "default multi boot composes in-memory audit and policy stores",
  },
  {
    guardId: "VULN-10",
    description: "ProviderRuntime no-arg isolated construction stamp",
    testFile: "src/domain/providers/__tests__/isolated-defaults.test.ts",
    neutralizeEnv: "NEUTRALIZE_VULN_10",
    expectedMessage: "composes zero ambient providers and has isIsolated",
  },
  {
    guardId: "VULN-16",
    description: "Inference tenancy arming threaded into executeLanguage call options",
    testFile: "src/domain/permissions/__tests__/composition-closure/inference-armed-journey.test.ts",
    neutralizeEnv: "NEUTRALIZE_VULN_16",
    expectedMessage: "CREDENTIAL_REQUIRED|EGRESS_REQUIRED",
  },
  {
    guardId: "VULN-17",
    description: "Built-in tool defs default-off on the multi server (tools gate)",
    testFile: "src/transport/http/__tests__/gateway-default-off.test.ts",
    neutralizeEnv: "NEUTRALIZE_VULN_17",
    expectedMessage: "never composes registry definitions into tenant context when tools are omitted",
  },
  {
    guardId: "VULN-19",
    description: "Worker control plane token-derived principal authentication",
    testFile: "examples/worker/src/__tests__/control-plane.test.ts",
    neutralizeEnv: "NEUTRALIZE_VULN_19",
    expectedMessage: "rejects unissued/forged tokens with 401",
  },
  {
    guardId: "P1-1-READ-IDENTITY",
    description: "Read-plane authorization-time dev+ino identity pin (parent-dir swap)",
    testFile: "src/domain/permissions/__tests__/composition-closure/symlink-read-journey.test.ts",
    neutralizeEnv: "NEUTRALIZE_P1_1_READ_IDENTITY",
    expectedMessage: "parent-directory symlink swap between authorization and execution is denied",
  },
  {
    guardId: "R2-LIFETIME-TRUTH",
    description: "Offered lifetimes exclude global in multi-tenant mode",
    testFile: "src/domain/permissions/__tests__/approval-lifetimes.test.ts",
    neutralizeEnv: "NEUTRALIZE_R2_LIFETIME_TRUTH",
    expectedMessage: "multi mode never offers 'global' in approval options",
  },
  {
    guardId: "R2-CAS-ONE-BUCKET",
    description: "One-bucket unstamped capability CAS dedup (no 2^K growth)",
    testFile: "src/domain/permissions/__tests__/cas-unstamped.test.ts",
    neutralizeEnv: "NEUTRALIZE_R2_CAS_ONE_BUCKET",
    expectedMessage: "unstamped capability appears exactly once after K sequential persistent approvals",
  },
];

interface RunOutcome {
  ok: boolean;
  failureReason?: string;
  failedTestCount: number;
  output: string;
}

function runJourney(testFile: string, neutralize: boolean, target: ProbeTarget): RunOutcome {
  const r = spawnSync("pnpm", ["vitest", "run", testFile], {
    stdio: "pipe",
    timeout: SPAWN_TIMEOUT_MS,
    env: neutralize
      ? {
          ...process.env,
          [target.neutralizeEnv]: "1",
          NEUTRALIZE_GUARD: target.guardId,
        }
      : { ...process.env },
  });

  const output = `${r.stdout?.toString() ?? ""}\n${r.stderr?.toString() ?? ""}`;
  // CI runners force ANSI colors even when piped; strip them before parsing
  // the vitest summary.
  const stripped = output.replace(/\x1b\[[0-9;]*m/g, "");

  if (r.error) {
    return { ok: false, failureReason: `spawn error: ${r.error.message}`, failedTestCount: 0, output };
  }
  if (r.status === null) {
    return { ok: false, failureReason: "no exit status (timeout or kill)", failedTestCount: 0, output };
  }

  // Parse the vitest summary, e.g. "Tests  3 failed | 4 passed (7)".
  const failedMatch = stripped.match(/Tests\s+(\d+) failed/);
  const failedTestCount = failedMatch ? Number(failedMatch[1]) : 0;
  const sawSummary =
    /Test Files\s+\d+ (failed|passed)/.test(stripped) || /Tests\s+\d+ (failed|passed)/.test(stripped);
  if (!sawSummary) {
    return { ok: false, failureReason: "no vitest summary in output (crash before test run?)", failedTestCount: 0, output };
  }

  return { ok: true, failedTestCount, output };
}

/** Production isGuardNeutralized("<id>") call sites, by id (fs glue — the
 *  lint rules live in src/foundations/probe-matrix.ts). */
function productionSeamIds(): Map<string, string[]> {
  const byId = new Map<string, string[]>();
  const out = execSync(
    `grep -rn 'isGuardNeutralized("' src examples --include='*.ts' | grep -v __tests__ | grep -v test-seams`,
    { encoding: "utf8" },
  );
  for (const line of out.split("\n")) {
    const file = line.split(":")[0];
    for (const m of line.matchAll(/isGuardNeutralized\("([^"]+)"\)/g)) {
      if (!byId.has(m[1])) byId.set(m[1], []);
      byId.get(m[1])!.push(file);
    }
  }
  return byId;
}

async function main() {
  console.log("=== Seepient Anti-Vacuity Mutation Probe Matrix ===");

  // WO1 T018/T019: the matrix enforces its own wiring before spending
  // minutes on journeys.
  try {
    const seams = productionSeamIds();
    assertSeamCoveragePure(PROBE_TARGETS, seams);
    const guardUsing = execSync(
      `grep -rln 'createSecurityGuard' src examples --include='*.test.ts' | grep -v _guard`,
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
    const violations = assertJourneyRegistrationPure(
      guardUsing,
      PROBE_TARGETS.map((t) => t.testFile),
      COUNTER_ONLY_JOURNEYS.map((c) => c.testFile),
    );
    for (const c of COUNTER_ONLY_JOURNEYS) {
      if (!PROBE_TARGETS.some((t) => t.testFile === c.testFile) && !existsSync(c.testFile)) {
        violations.push(`COUNTER_ONLY_JOURNEYS entry ${c.testFile} does not exist on disk`);
      }
    }
    if (violations.length > 0) {
      throw new Error(`REGISTRATION violations:\n  - ${violations.join("\n  - ")}`);
    }
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  }
  console.log("lints: seam coverage + journey registration verified.\n");

  console.log(`Executing ${PROBE_TARGETS.length} mutation probes (green baseline + neutralized red)...\n`);

  let verified = 0;
  for (const t of PROBE_TARGETS) {
    console.log(`[PROBE] Mutating guard ${t.guardId}: ${t.description}`);

    // 1. Green baseline: the journey must pass with the guard intact.
    const baseline = runJourney(t.testFile, false, t);
    if (!baseline.ok) {
      console.error(`FAIL: ${t.guardId}: baseline run could not execute (${baseline.failureReason})`);
      process.exit(1);
    }
    if (baseline.failedTestCount > 0) {
      console.error(
        `FAIL: ${t.guardId}: journey is not green before neutralization (${baseline.failedTestCount} failed in ${t.testFile}); fix the journey first`,
      );
      process.exit(1);
    }
    console.log("  baseline: green");

    // 2. Neutralized run: must be red with at least one failed test.
    const neutralized = runJourney(t.testFile, true, t);
    if (!neutralized.ok) {
      console.error(`FAIL: ${t.guardId}: neutralized run could not execute (${neutralized.failureReason})`);
      process.exit(1);
    }
    if (neutralized.failedTestCount === 0) {
      console.error(
        `FAIL: ${t.guardId}: journey stayed green under neutralization — guard is not load-bearing (${t.testFile})`,
      );
      process.exit(1);
    }
    // 022-5 FR-008 + WO1 T021: the red must be the SECURITY assertion, not
    // an unrelated failure. The marker must appear in the FAIL section (the
    // failing tests' names and assertion output) — a marker echoed only by a
    // PASSING test's stdout is not evidence. Alternation markers ("A|B")
    // match when any single alternative appears in the FAIL section.
    const failSection = extractFailSection(neutralized.output);
    if (!markerMatches(failSection, t.expectedMessage)) {
      console.error(
        `FAIL: ${t.guardId}: neutralized run failed ${neutralized.failedTestCount} test(s) but the FAIL section carries none of the expected security marker(s) "${t.expectedMessage}" — the red is not evidence (wrong test failing?)`,
      );
      process.exit(1);
    }
    console.log(`  ✓ turned RED under neutralization with the expected security marker (${neutralized.failedTestCount} test(s) failed)\n`);
    verified++;
  }

  console.log(`All ${verified} mutation probes verified: every journey is green with its guard and red without it.`);
}

main().catch((err) => {
  console.error("Mutation probe execution failed:", err);
  process.exit(1);
});
