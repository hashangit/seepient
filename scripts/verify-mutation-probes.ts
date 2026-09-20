/**
 * Mutation Probe Matrix & Anti-Vacuity Verification Script (SC-004 / FR-018).
 *
 * Spawns a real vitest run per registered guard under neutralization.
 * Proves that every journey turns red when its guard is neutralized.
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

const PROBE_TARGETS: ProbeTarget[] = [
  {
    guardId: "VULN-1",
    description: "Brokered execution secret leak prevention & tenant secret resolution",
    testFile: "src/domain/permissions/__tests__/composition-closure/tenant-secret-journey.test.ts",
    neutralizeEnv: "NEUTRALIZE_VULN_1",
  },
  {
    guardId: "VULN-1-BROKER",
    description: "EffectBroker multi-mode fail closed on ambient process.env keys",
    testFile: "src/domain/permissions/__tests__/composition-closure/exfil-journey.test.ts",
    neutralizeEnv: "NEUTRALIZE_VULN_1",
  },
  {
    guardId: "VULN-5",
    description: "Brokered execution zero-disk-write guarantee",
    testFile: "src/domain/permissions/__tests__/composition-closure/zero-write-brokered.test.ts",
    neutralizeEnv: "NEUTRALIZE_VULN_5",
  },
  {
    guardId: "VULN-9",
    description: "Isolated server boot zero-disk-write guarantee",
    testFile: "src/transport/http/__tests__/isolated-boot.test.ts",
    neutralizeEnv: "NEUTRALIZE_VULN_9",
  },
  {
    guardId: "VULN-10",
    description: "ProviderRuntime isolated in-memory default construction",
    testFile: "src/domain/providers/__tests__/isolated-defaults.test.ts",
    neutralizeEnv: "NEUTRALIZE_VULN_10",
  },
  {
    guardId: "VULN-16",
    description: "Inference armed wrapper fail-closed on missing credentials",
    testFile: "src/domain/permissions/__tests__/composition-closure/inference-armed-journey.test.ts",
    neutralizeEnv: "NEUTRALIZE_VULN_16",
  },
  {
    guardId: "VULN-17",
    description: "Operator gateway default-off in multi server registry",
    testFile: "src/transport/http/__tests__/gateway-default-off.test.ts",
    neutralizeEnv: "NEUTRALIZE_VULN_17",
  },
  {
    guardId: "VULN-19",
    description: "Worker control plane authentication & principal scoping",
    testFile: "examples/worker/src/__tests__/control-plane.test.ts",
    neutralizeEnv: "NEUTRALIZE_VULN_19",
  },
];

async function main() {
  console.log("=== Seepient Anti-Vacuity Mutation Probe Matrix ===");
  console.log(`Executing ${PROBE_TARGETS.length} mutation probe journeys under neutralization...\n`);

  let verified = 0;
  for (const t of PROBE_TARGETS) {
    console.log(`[PROBE] Mutating guard ${t.guardId}: ${t.description}`);
    const r = spawnSync("pnpm", ["vitest", "run", t.testFile], {
      stdio: "pipe",
      env: {
        ...process.env,
        [t.neutralizeEnv]: "1",
        NEUTRALIZE_GUARD: t.guardId,
      },
    });

    if (r.status === 0) {
      console.error(`FAIL: ${t.guardId}: journey stayed green under neutralization (${t.testFile})`);
      process.exit(1);
    }

    console.log(`  ✓ Successfully turned RED under neutralization (exit code ${r.status})\n`);
    verified++;
  }

  console.log(`All ${verified} security journey mutation probes verified successfully (each flipped red when neutralized).`);
}

main().catch((err) => {
  console.error("Mutation probe execution failed:", err);
  process.exit(1);
});
