/**
 * Seepient TUI — Model & Provider Manager Dock
 *
 * Implements the full provider management dock:
 * - Purpose × tier matrix dock with capability gating
 * - Two-pool view (Language vs Image providers) over live configured accounts
 * - Thinking level picker
 * - Status dock with "Applies next turn" indicator
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useTheme } from '../hooks/use-theme.js';
import type { PurposeModelMap } from '../../../foundations/schemas/provider-config.js';
import type { UpstreamModel, ThinkingLevel } from '../../../foundations/schemas/inference.js';

export interface ModelManagerProps {
  assignments?: Record<string, any>;
  catalog?: readonly UpstreamModel[];
  providers?: Record<string, { adapter?: string; upstreamProvider?: string; baseUrl?: string }>;
  activeAccount?: string;
  activeModel?: string;
  activeThinking?: ThinkingLevel;
  onUpdateAssignment?: (purpose: string, tier: string, target: { providerAccount: string; model: string; thinkingLevel?: ThinkingLevel }) => void;
  onClose: () => void;
}

const PURPOSES = [
  { id: "text", name: "Text (Agent Loop)", category: "language" },
  { id: "plan", name: "Planning & Reason", category: "language" },
  { id: "vision", name: "Vision Analysis", category: "language" },
  { id: "commit", name: "Git Commit Agent", category: "language" },
  { id: "image-generation", name: "Image Generation", category: "image" },
  { id: "tts", name: "Speech Synthesis", category: "media", status: "Coming soon" },
  { id: "stt", name: "Speech Recognition", category: "media", status: "Coming soon" },
  { id: "video-generation", name: "Video Generation", category: "media", status: "Coming soon" },
];

const TIERS = ["efficient", "standard", "complex"] as const;

export function ModelManager({
  assignments = {},
  catalog = [],
  providers = {},
  activeAccount = "default",
  activeModel = "gpt-4o",
  activeThinking = "none",
  onUpdateAssignment,
  onClose,
}: ModelManagerProps) {
  const theme = useTheme();
  const [activeTab, setActiveTab] = useState<"matrix" | "providers" | "status">("matrix");
  const [poolFilter, setPoolFilter] = useState<"language" | "image">("language");
  const [selectedSlotIndex, setSelectedSlotIndex] = useState(0);

  const activePurposes = PURPOSES.filter((p) => p.category === poolFilter || (poolFilter === "image" && p.category === "media"));

  // Helper to find eligible models for capability
  const eligibleModels = catalog.filter((m) => {
    if (poolFilter === "image") {
      return !!(m.capabilities?.imageGenerate || m.capabilities?.imageEdit);
    }
    return !!(m.capabilities?.streaming || m.capabilities?.toolUse);
  });

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (input === "1") setActiveTab("matrix");
    if (input === "2") setActiveTab("providers");
    if (input === "3") setActiveTab("status");
    if (input === "p" || input === "P" || key.tab) {
      setPoolFilter((p) => (p === "language" ? "image" : "language"));
    }
    if (key.upArrow) {
      setSelectedSlotIndex((i) => Math.max(0, i - 1));
    } else if (key.downArrow) {
      setSelectedSlotIndex((i) => Math.min(activePurposes.length * TIERS.length - 1, i + 1));
    } else if ((key.return || input === " ") && onUpdateAssignment && eligibleModels.length > 0) {
      const pIdx = Math.floor(selectedSlotIndex / TIERS.length);
      const tIdx = selectedSlotIndex % TIERS.length;
      const targetPurpose = activePurposes[pIdx];
      const targetTier = TIERS[tIdx];

      if (targetPurpose && !targetPurpose.status) {
        const currentSlot = (assignments as any)?.[targetPurpose.id]?.[targetTier];
        const currentModelId = currentSlot?.model;
        const currentModelIdx = eligibleModels.findIndex((m) => m.id === currentModelId);
        const nextModel = eligibleModels[(currentModelIdx + 1) % eligibleModels.length];
        if (nextModel) {
          const matchingAccount =
            Object.entries(providers).find(
              ([acct, info]) =>
                acct === nextModel.upstreamProvider ||
                (info as any).upstreamProvider === nextModel.upstreamProvider ||
                (info as any).adapter === nextModel.upstreamProvider,
            )?.[0] ||
            Object.keys(providers)[0] ||
            nextModel.upstreamProvider ||
            "default";

          onUpdateAssignment(targetPurpose.id, targetTier, {
            providerAccount: matchingAccount,
            model: nextModel.id,
            thinkingLevel: currentSlot?.thinkingLevel ?? "none",
          });
        }
      }
    }
  });

  const providerEntries = Object.entries(providers);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.purple} paddingLeft={1} paddingRight={1}>
      {/* Header & Tabs */}
      <Box justifyContent="space-between" marginBottom={1}>
        <Box>
          <Text bold color={theme.purple}>Model & Provider Manager </Text>
          <Text color={activeTab === "matrix" ? theme.cyan : theme.fgDim}>[1 Matrix] </Text>
          <Text color={activeTab === "providers" ? theme.cyan : theme.fgDim}>[2 Providers] </Text>
          <Text color={activeTab === "status" ? theme.cyan : theme.fgDim}>[3 Status]</Text>
        </Box>
        <Box>
          <Text color={theme.fgDim}>Pool: </Text>
          <Text bold color={poolFilter === "language" ? theme.green : theme.purple}>
            {poolFilter.toUpperCase()} (Tab/P)
          </Text>
        </Box>
      </Box>

      {/* Tab 1: Matrix View */}
      {activeTab === "matrix" && (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text color={theme.fgDim}>
              Purpose × Tier Assignments · [Enter/Space] Cycle Model · Applies next turn boundary
            </Text>
          </Box>

          {activePurposes.map((p, pIdx) => {
            if (p.status) {
              return (
                <Box key={p.id} justifyContent="space-between" paddingLeft={1}>
                  <Text color={theme.fgDim}>{p.name.padEnd(24)}</Text>
                  <Text color={theme.yellow}>[{p.status}]</Text>
                </Box>
              );
            }

            const pAssignments = (assignments as any)?.[p.id] ?? {};

            return (
              <Box key={p.id} flexDirection="column" marginBottom={1}>
                <Text bold color={theme.cyan}>{p.name}</Text>
                {TIERS.map((t, tIdx) => {
                  const flatIdx = pIdx * TIERS.length + tIdx;
                  const isSelected = flatIdx === selectedSlotIndex;
                  const slot = pAssignments[t];
                  const configured = !!slot;
                  const modelStr = slot ? `${slot.providerAccount}/${slot.model}` : "(unconfigured)";
                  const thStr = slot?.thinkingLevel ? ` [thinking: ${slot.thinkingLevel}]` : "";

                  // Check capabilities for capability gating
                  const modelMeta = catalog.find((m) => m.id === slot?.model);
                  const isGated = modelMeta && !modelMeta.capabilities?.toolUse && p.category === "language";

                  return (
                    <Box key={t} paddingLeft={2} backgroundColor={isSelected ? theme.blue : undefined}>
                      <Text color={configured ? (isGated ? theme.yellow : theme.green) : theme.yellow}>
                        {configured ? (isGated ? "▲ " : "● ") : "○ "}
                      </Text>
                      <Text color={isSelected ? theme.bg : (isGated ? theme.fgDim : theme.fg)} bold={isSelected}>
                        {t.padEnd(12)} → {modelStr}{thStr} {isGated ? "(limited tools)" : ""}
                      </Text>
                    </Box>
                  );
                })}
              </Box>
            );
          })}
        </Box>
      )}

      {/* Tab 2: Providers & Accounts */}
      {activeTab === "providers" && (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text bold color={theme.cyan}>Active Provider Accounts ({poolFilter} pool):</Text>
          </Box>
          <Box paddingLeft={1} flexDirection="column">
            {providerEntries.length > 0 ? (
              providerEntries.map(([id, info]) => (
                <Text key={id} color={theme.green}>
                  ● {id} ({info.upstreamProvider || info.adapter || "provider"}) {info.baseUrl ? `· ${info.baseUrl}` : ""}
                </Text>
              ))
            ) : (
              <Box flexDirection="column">
                <Text color={theme.yellow}>○ No provider accounts configured in active overlay.</Text>
                <Text color={theme.fgDim}>
                  Configured via environment variables or default providers.
                </Text>
              </Box>
            )}
          </Box>
          <Box marginTop={1}>
            <Text color={theme.fgDim}>
              Use `seepient providers add/edit` or `seepient auth login` to configure accounts.
            </Text>
          </Box>
        </Box>
      )}

      {/* Tab 3: Current Turn Status */}
      {activeTab === "status" && (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text bold color={theme.cyan}>Active Serving Targets (Current Turn):</Text>
          </Box>
          <Box paddingLeft={1} flexDirection="column">
            <Text color={theme.fg}>Active Account: <Text bold color={theme.green}>{activeAccount}</Text></Text>
            <Text color={theme.fg}>Serving Model:  <Text bold color={theme.green}>{activeModel}</Text></Text>
            <Text color={theme.fg}>Thinking Level: <Text bold color={theme.purple}>{activeThinking}</Text></Text>
            <Box marginTop={1}>
              <Text color={theme.fgDim}>
                * Changes made via /models take effect on next turn boundary.
              </Text>
            </Box>
          </Box>
        </Box>
      )}

      {/* Footer Navigation */}
      <Box marginTop={1} borderStyle="single" borderColor={theme.fgDim} paddingTop={0}>
        <Text color={theme.fgDim}>
          ↑/↓ Navigate slots · 1/2/3 Tabs · Tab/P Switch pool · Esc Close
        </Text>
      </Box>
    </Box>
  );
}
