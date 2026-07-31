import { Box, Text } from "ink";
import { useTheme } from "../hooks/use-theme.js";
import type {
  ChangeProposal,
  ActivationStatus,
} from "../../../foundations/contracts/self-evolution.js";

/**
 * Self-evolution candidate/verification/activation status panel (spec 008,
 * T308, FR-019/FR-020/FR-021).
 *
 * Renders the deterministic facts about a self-evolution candidate:
 *  - candidate + parent digests (content-addressed, tamper-evident)
 *  - change classification (delegated / protected / needs-attestation)
 *  - verification evidence (per-check pass/fail)
 *  - activation authority + status
 *
 * The UI distinguishes **ability to prepare** from **authority to activate**.
 * For a non-delegated or security-sensitive change, it shows that the
 * candidate may be tested but cannot replace active trusted state. When no
 * supervisor is configured, the deterministic status is
 * `verified-pending-activation` — the UI never implies an in-process fallback.
 */
export interface SelfEvolutionStatusProps {
  proposal: ChangeProposal;
  classification:
    | { status: "delegated"; rule: { supervisorId?: string } }
    | { status: "protected"; protectedClasses: string[] }
    | { status: "needs-attestation" }
    | { status: "disallowed"; disallowedClasses: string[] };
  activationStatus?: ActivationStatus;
  supervisorConfigured: boolean;
}

export function SelfEvolutionStatus({
  proposal,
  classification,
  activationStatus,
  supervisorConfigured,
}: SelfEvolutionStatusProps) {
  const theme = useTheme();
  const candidateShort = proposal.candidateArtifactDigest.slice(0, 16);
  const parentShort = proposal.parentArtifactDigest.slice(0, 16);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.blue} paddingX={1}>
      <Box>
        <Text color={theme.blue} bold>◆ Self-maintenance candidate</Text>
      </Box>

      <Box marginTop={1}>
        <Text color={theme.cyan}>  Candidate  </Text>
        <Text color={theme.fg}>sha256:{candidateShort}…</Text>
      </Box>
      <Box>
        <Text color={theme.cyan}>  Parent     </Text>
        <Text color={theme.fgDim}>sha256:{parentShort}…</Text>
      </Box>
      <Box>
        <Text color={theme.cyan}>  Class      </Text>
        <Text color={theme.fg}>{proposal.changeClasses.join(", ")}</Text>
      </Box>

      {/* Verification evidence — deterministic, derived from isolated worker runs */}
      <Box marginTop={1}>
        <Text color={theme.cyan}>  Checks     </Text>
        {proposal.verification.length === 0 ? (
          <Text color={theme.fgDim}>(none required)</Text>
        ) : (
          proposal.verification.map((v) => (
            <Text key={v.checkId} color={v.state === "passed" ? theme.green : theme.red}>
              {" "}{v.checkId}:{v.state === "passed" ? "✓" : "✗"}
            </Text>
          ))
        )}
      </Box>

      {/* Classification — trusted base policy, not candidate-provided */}
      <Box marginTop={1}>
        <Text color={theme.cyan}>  Classify   </Text>
        <ClassificationLabel classification={classification} theme={theme} />
      </Box>

      {/* Activation authority — explicitly separate from ability to prepare */}
      <Box>
        <Text color={theme.cyan}>  Activate   </Text>
        <ActivationLabel
          classification={classification}
          activationStatus={activationStatus}
          supervisorConfigured={supervisorConfigured}
          theme={theme}
        />
      </Box>

      {/* Honest status — no in-process fallback implication */}
      <Box marginTop={1}>
        <Text color={theme.fgDim}>
          {classification.status === "protected"
            ? "Candidate may be tested, but cannot replace active trusted state."
            : !supervisorConfigured
              ? "verified-pending-activation (no supervisor configured)"
              : `submitted · activation id ${activationStatus ?? "—"}`}
        </Text>
      </Box>
    </Box>
  );
}

function ClassificationLabel({
  classification,
  theme,
}: {
  classification: SelfEvolutionStatusProps["classification"];
  theme: ReturnType<typeof useTheme>;
}) {
  switch (classification.status) {
    case "delegated":
      return <Text color={theme.green}>delegated (supervisor: {classification.rule.supervisorId ?? "—"})</Text>;
    case "protected":
      return (
        <Text color={theme.red}>
          protected — {classification.protectedClasses.join(", ")} (independent authority required)
        </Text>
      );
    case "needs-attestation":
      return <Text color={theme.yellow}>needs-attestation (independent verifier required)</Text>;
    case "disallowed":
      return <Text color={theme.red}>disallowed — {classification.disallowedClasses.join(", ")} not permitted</Text>;
  }
}

function ActivationLabel({
  classification,
  activationStatus,
  supervisorConfigured,
  theme,
}: {
  classification: SelfEvolutionStatusProps["classification"];
  activationStatus?: ActivationStatus;
  supervisorConfigured: boolean;
  theme: ReturnType<typeof useTheme>;
}) {
  if (classification.status === "protected") {
    return <Text color={theme.red}>authority required (cannot self-attest)</Text>;
  }
  if (!supervisorConfigured) {
    return <Text color={theme.yellow}>no supervisor configured (pending)</Text>;
  }
  return <Text color={theme.green}>{activationStatus ?? "ready"}</Text>;
}
