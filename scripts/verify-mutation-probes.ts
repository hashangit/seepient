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
 * (src/foundations/test-seams.ts, inert unless NODE_ENV === "test"), so a red
 * verdict proves the guard is load-bearing for that journey.
 *
 * Usage:
 *   pnpm tsx scripts/verify-mutation-probes.ts
 */

import { spawnSync } from "node:child_process";

interface ProbeTarget {
  guardId: string;
  description: string;
  testFile: string;
  neutralizeEnv: string;
}

const SPAWN_TIMEOUT_MS = 180_000;

const PROBE_TARGETS: ProbeTarget[] = [
  {
    guardId: "VULN-1",
    description: "EffectBroker multi-mode ambient-secret fail-closed (resolveSecret)",
    testFile: "src/domain/permissions/__tests__/composition-closure/tenant-secret-journey.test.ts",
    neutralizeEnv: "NEUTRALIZE_VULN_1",
  },
  {
    guardId: "VULN-1-BROKER",
    description: "EffectBroker multi-mode ambient process.env key exfiltration",
    testFile: "src/domain/permissions/__tests__/composition-closure/exfil-journey.test.ts",
    neutralizeEnv: "NEUTRALIZE_VULN_1",
  },
  {
    guardId: "VULN-5",
    description: "InMemoryReplayLedger default in multi (brokered zero-disk-write)",
    testFile: "src/domain/permissions/__tests__/composition-closure/zero-write-brokered.test.ts",
    neutralizeEnv: "NEUTRALIZE_VULN_5",
  },
  {
    guardId: "VULN-9",
    description: "Server multi-mode in-memory store defaults (isolated boot zero-write)",
    testFile: "src/transport/http/__tests__/isolated-boot.test.ts",
    neutralizeEnv: "NEUTRALIZE_VULN_9",
  },
  {
    guardId: "VULN-10",
    description: "ProviderRuntime no-arg isolated construction stamp",
    testFile: "src/domain/providers/__tests__/isolated-defaults.test.ts",
    neutralizeEnv: "NEUTRALIZE_VULN_10",
  },
  {
    guardId: "VULN-16",
    description: "Inference tenancy arming threaded into executeLanguage call options",
    testFile: "src/domain/permissions/__tests__/composition-closure/inference-armed-journey.test.ts",
    neutralizeEnv: "NEUTRALIZE_VULN_16",
  },
  {
    guardId: "VULN-17",
    description: "Built-in tool defs default-off on the multi server (tools gate)",
    testFile: "src/transport/http/__tests__/gateway-default-off.test.ts",
    neutralizeEnv: "NEUTRALIZE_VULN_17",
  },
  {
    guardId: "VULN-19",
    description: "Worker control plane token-derived principal authentication",
    testFile: "examples/worker/src/__tests__/control-plane.test.ts",
    neutralizeEnv: "NEUTRALIZE_VULN_19",
  },
  {
    guardId: "P1-1-READ-IDENTITY",
    description: "Read-plane authorization-time dev+ino identity pin (parent-dir swap)",
    testFile: "src/domain/permissions/__tests__/composition-closure/symlink-read-journey.test.ts",
    neutralizeEnv: "NEUTRALIZE_P1_1_READ_IDENTITY",
  },
  {
    guardId: "R2-LIFETIME-TRUTH",
    description: "Offered lifetimes exclude global in multi-tenant mode",
    testFile: "src/domain/permissions/__tests__/approval-lifetimes.test.ts",
    neutralizeEnv: "NEUTRALIZE_R2_LIFETIME_TRUTH",
  },
  {
    guardId: "R2-CAS-ONE-BUCKET",
    description: "One-bucket unstamped capability CAS dedup (no 2^K growth)",
    testFile: "src/domain/permissions/__tests__/cas-unstamped.test.ts",
    neutralizeEnv: "NEUTRALIZE_R2_CAS_ONE_BUCKET",
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

async function main() {
  console.log("=== Seepient Anti-Vacuity Mutation Probe Matrix ===");
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
    console.log(`  ✓ turned RED under neutralization (${neutralized.failedTestCount} test(s) failed)\n`);
    verified++;
  }

  console.log(`All ${verified} mutation probes verified: every journey is green with its guard and red without it.`);
}

main().catch((err) => {
  console.error("Mutation probe execution failed:", err);
  process.exit(1);
});
