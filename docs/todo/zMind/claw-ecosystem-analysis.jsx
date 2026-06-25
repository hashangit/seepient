import { useState } from "react";

const COLORS = {
  bg: "#0a0e17",
  surface: "#111827",
  surfaceHover: "#1a2234",
  border: "#1e293b",
  text: "#e2e8f0",
  textMuted: "#94a3b8",
  textDim: "#64748b",
  accent: "#3b82f6",
  green: "#10b981",
  amber: "#f59e0b",
  red: "#ef4444",
  purple: "#8b5cf6",
  pink: "#ec4899",
  cyan: "#06b6d4",
};

const clawVariants = [
  {
    name: "OpenClaw",
    stars: "259K",
    lang: "TypeScript / Node.js",
    license: "MIT",
    fit: 95,
    verdict: "RECOMMENDED BASE",
    color: COLORS.green,
    pros: [
      "Mature ecosystem — 259K stars, 47K+ forks, 100+ community skills",
      "Already has SOUL.md, AGENTS.md, USER.md, MEMORY.md, HEARTBEAT.md — maps directly to our CAA docs",
      "Bootstrap files are injected into system prompt every turn (not chat history) — exactly our Tier 1 pattern",
      "Heartbeat cron system built-in (default 30 min) — maps to our HEARTBEAT.md",
      "Skills system (SKILL.md with YAML frontmatter) — extensible for our custom cognitive layers",
      "Memory: daily markdown logs + MEMORY.md long-term + memory_search (embedding + FTS5)",
      "Multi-channel: WhatsApp, Telegram, Discord, Slack, Signal, iMessage, Matrix, IRC, Teams",
      "Model-agnostic: Claude, GPT, Gemini, DeepSeek, Ollama, local models",
      "File-based — all config/memory/identity in editable markdown on disk, Git-backable",
      "Configurable bootstrap files (Issue #9491 requesting custom injection — community want exists)",
      "Sub-agent support with isolated sessions for delegated tasks",
      "agent:bootstrap hook allows intercepting/mutating injected files at runtime",
    ],
    cons: [
      "Heavy: ~150MB binary, 1GB+ RAM, requires Node.js runtime",
      "Security concerns documented by Cisco and CrowdStrike — needs hardening",
      "Prompt injection surface is large due to broad tool/exec access",
      "No built-in programmatic pipeline (RAS→DMN→AMG) — but this is fine since we want LLM-driven flow",
      "Creator joined OpenAI — future governance via open-source foundation (TBD)",
    ],
  },
  {
    name: "ZeroClaw",
    stars: "17K",
    lang: "Rust",
    license: "MIT + Apache-2.0",
    fit: 70,
    verdict: "STRONG ALTERNATIVE",
    color: COLORS.amber,
    pros: [
      "Ultra-lightweight: 3.4MB binary, <5MB RAM, <10ms cold start",
      "Rust memory safety guarantees — no runtime crashes from null/undefined",
      "Trait-based architecture — every subsystem is swappable via config",
      "Built-in hybrid memory: 70% vector + 30% FTS5 keyword search in SQLite",
      "Same HEARTBEAT.md concept + cron scheduler",
      "zeroclaw migrate openclaw — built-in migration from OpenClaw",
      "Runs on $10 hardware (Raspberry Pi, edge devices)",
      "22+ provider support, 17+ channels",
      "Strict security: pairing, sandboxing, allowlists, encrypted secrets",
    ],
    cons: [
      "Much smaller community (17K stars vs 259K)",
      "Younger project — less battle-tested in production",
      "Rust codebase — harder to modify if team isn't Rust-fluent",
      "Needs compilation from source on some platforms (~2GB RAM, ~6GB disk for build)",
      "Less mature skill ecosystem compared to OpenClaw's ClawHub",
      "No equivalent to OpenClaw's agent:bootstrap hook system yet",
    ],
  },
  {
    name: "IronClaw",
    stars: "3.2K",
    lang: "Rust",
    license: "MIT + Apache-2.0",
    fit: 50,
    verdict: "NICHE — Privacy Focus",
    color: COLORS.purple,
    pros: [
      "Zero external dependencies for core — runs fully air-gapped",
      "Privacy-first: no telemetry, no phone-home, complete offline operation",
      "Good for regulated industries (legal, healthcare, defense)",
    ],
    cons: [
      "Very small community (3.2K stars)",
      "More opinionated architecture — less flexible for custom cognitive layers",
      "No skill marketplace or community extensions",
      "Less documentation and examples available",
    ],
  },
  {
    name: "NanoClaw",
    stars: "~1K",
    lang: "TypeScript",
    license: "MIT",
    fit: 40,
    verdict: "TOO MINIMAL",
    color: COLORS.textDim,
    pros: [
      "Only ~15 source files, 9 runtime deps — auditable in an afternoon",
      "Same language as OpenClaw (TypeScript) — easy to understand",
      "Bun-native runtime, runs in containers",
      "Built on Anthropic's Agents SDK directly",
    ],
    cons: [
      "Single-bot only — no multi-agent support",
      "No memory search — loses context with 50+ memory files",
      "No HTTP API built-in — would need to add for any dashboard/portal",
      "Too stripped down — we'd be rebuilding most of what OpenClaw already has",
    ],
  },
  {
    name: "nanobot / mini-claw / PicoClaw",
    stars: "<1K",
    lang: "Various",
    license: "Various",
    fit: 20,
    verdict: "LEARNING TOOLS ONLY",
    color: COLORS.textDim,
    pros: [
      "Great for understanding how agents work",
      "Run on Raspberry Pi and resource-constrained devices",
    ],
    cons: [
      "Too minimal for production use",
      "No memory systems, no skill ecosystems",
      "Would require building 90%+ of our architecture from scratch",
    ],
  },
];

const fileMapping = [
  {
    caa: "Constitution.md",
    openclaw: "SOUL.md + AGENTS.md",
    notes: "SOUL.md = identity/personality (who). AGENTS.md = operating rules/behavior (how). Our Constitution combines both. We can either merge into one or keep OpenClaw's separation.",
    action: "Extend SOUL.md with our Constitution principles. Keep AGENTS.md for operational rules.",
    color: COLORS.purple,
  },
  {
    caa: "RAS.md",
    openclaw: "— (NEW)",
    notes: "No equivalent in OpenClaw. This is our novel contribution. Inject as additional bootstrap file using the agent:bootstrap hook or by adding to the hardcoded injection list.",
    action: "Create RAS.md as new bootstrap file. Add to system prompt injection pipeline.",
    color: COLORS.amber,
  },
  {
    caa: "MEMORY.md",
    openclaw: "MEMORY.md + memory/*.md",
    notes: "Direct match. OpenClaw already has MEMORY.md (long-term) + daily memory logs + memory_search. We add our recency weighting and consolidation logic.",
    action: "Use existing memory system. Add consolidation skill with 30/70 weighting formula.",
    color: COLORS.green,
  },
  {
    caa: "DMN.md",
    openclaw: "— (NEW)",
    notes: "No equivalent. OpenClaw's SOUL.md is static persona. Our DMN is a dynamic self-model that the agent auto-updates. Novel contribution.",
    action: "Create DMN.md as new bootstrap file. Build heartbeat task for periodic self-reflection updates.",
    color: COLORS.amber,
  },
  {
    caa: "AMG.md",
    openclaw: "Safety section (partial)",
    notes: "OpenClaw has a brief Safety section in the system prompt but it's minimal. Our AMG is a dedicated, comprehensive, STATIC safety document with escalation matrix.",
    action: "Create AMG.md as new bootstrap file. Much more comprehensive than existing safety section.",
    color: COLORS.amber,
  },
  {
    caa: "HEARTBEAT.md",
    openclaw: "HEARTBEAT.md",
    notes: "Direct match. OpenClaw already has this with cron-based execution. 30-min default, configurable. Agent reads it, decides whether to act or reply HEARTBEAT_OK.",
    action: "Use existing system. Extend with our memory consolidation + DMN update tasks.",
    color: COLORS.green,
  },
  {
    caa: "SOP.md",
    openclaw: "Skills (SKILL.md)",
    notes: "OpenClaw skills are task-specific procedures with triggers. Our SOP is more comprehensive but the concept maps well. We can create SOP as a skill or bootstrap file.",
    action: "Create SOP.md as bootstrap file. Individual procedures can also be skills.",
    color: COLORS.cyan,
  },
  {
    caa: "SOW.md",
    openclaw: "— (partial via HEARTBEAT)",
    notes: "OpenClaw's heartbeat handles some 'daily routine' functions. Our SOW is a broader job description. No direct equivalent.",
    action: "Create SOW.md as new bootstrap file. Reference from HEARTBEAT.md for daily execution.",
    color: COLORS.amber,
  },
  {
    caa: "/learning/ folder",
    openclaw: "memory/ folder (partial)",
    notes: "OpenClaw has memory/ for conversation logs. Our /learning/ is for self-generated study notes — different purpose. Can coexist.",
    action: "Create /learning/ folder in workspace. Add skill for study note management.",
    color: COLORS.cyan,
  },
];

function FitBar({ value, color }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%" }}>
      <div style={{ flex: 1, height: 6, background: COLORS.bg, borderRadius: 3, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${value}%`, background: color, borderRadius: 3, transition: "width 0.5s" }} />
      </div>
      <span style={{ fontSize: 12, fontWeight: 700, color, fontFamily: "'JetBrains Mono', monospace", minWidth: 36 }}>{value}%</span>
    </div>
  );
}

export default function ClawAnalysis() {
  const [view, setView] = useState("comparison");
  const [expandedVariant, setExpandedVariant] = useState("OpenClaw");
  const [expandedMapping, setExpandedMapping] = useState(null);

  return (
    <div style={{ background: COLORS.bg, color: COLORS.text, minHeight: "100vh", fontFamily: "'Inter', -apple-system, sans-serif", padding: "24px 20px" }}>
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet" />

      <div style={{ maxWidth: 900, margin: "0 auto" }}>
        <div style={{ marginBottom: 28 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
            <span style={{ fontSize: 24 }}>🦞</span>
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 800, letterSpacing: "-0.02em" }}>
              -Claw Ecosystem Analysis
            </h1>
          </div>
          <p style={{ color: COLORS.textDim, fontSize: 13, margin: "4px 0 0 34px" }}>
            Evaluating FOSS agent frameworks as a base for the Cognitive Agent Architecture
          </p>
        </div>

        <div style={{ display: "flex", gap: 4, marginBottom: 20, background: COLORS.surface, padding: 4, borderRadius: 10, width: "fit-content" }}>
          {[
            { id: "comparison", label: "Variant Comparison" },
            { id: "mapping", label: "CAA → OpenClaw Mapping" },
            { id: "plan", label: "Implementation Plan" },
          ].map(tab => (
            <button key={tab.id} onClick={() => setView(tab.id)} style={{
              background: view === tab.id ? COLORS.surfaceHover : "transparent",
              border: view === tab.id ? `1px solid ${COLORS.border}` : "1px solid transparent",
              color: view === tab.id ? COLORS.text : COLORS.textDim,
              padding: "8px 16px", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 500,
            }}>
              {tab.label}
            </button>
          ))}
        </div>

        {view === "comparison" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {clawVariants.map(v => (
              <div key={v.name} onClick={() => setExpandedVariant(expandedVariant === v.name ? null : v.name)}
                style={{
                  background: COLORS.surface, borderRadius: 12, overflow: "hidden", cursor: "pointer",
                  border: `1px solid ${expandedVariant === v.name ? v.color + "44" : COLORS.border}`,
                }}>
                {expandedVariant === v.name && <div style={{ height: 3, background: v.color }} />}
                <div style={{ padding: "14px 18px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
                    <span style={{ fontSize: 16, fontWeight: 800 }}>{v.name}</span>
                    <span style={{
                      background: `${v.color}22`, color: v.color, fontSize: 10, fontWeight: 700,
                      padding: "2px 10px", borderRadius: 99, fontFamily: "'JetBrains Mono', monospace",
                    }}>{v.verdict}</span>
                    <div style={{ marginLeft: "auto", display: "flex", gap: 12, fontSize: 11, color: COLORS.textDim }}>
                      <span>⭐ {v.stars}</span>
                      <span>{v.lang}</span>
                      <span>{v.license}</span>
                    </div>
                  </div>
                  <FitBar value={v.fit} color={v.color} />

                  {expandedVariant === v.name && (
                    <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 700, color: COLORS.green, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em" }}>Advantages</div>
                        {v.pros.map((p, i) => (
                          <div key={i} style={{ display: "flex", gap: 8, marginBottom: 6, fontSize: 12, color: COLORS.textMuted, lineHeight: 1.4 }}>
                            <span style={{ color: COLORS.green, flexShrink: 0 }}>+</span>
                            <span>{p}</span>
                          </div>
                        ))}
                      </div>
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 700, color: COLORS.red, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em" }}>Concerns</div>
                        {v.cons.map((c, i) => (
                          <div key={i} style={{ display: "flex", gap: 8, marginBottom: 6, fontSize: 12, color: COLORS.textMuted, lineHeight: 1.4 }}>
                            <span style={{ color: COLORS.red, flexShrink: 0 }}>−</span>
                            <span>{c}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {view === "mapping" && (
          <div>
            <div style={{
              background: `${COLORS.green}11`, border: `1px solid ${COLORS.green}33`, borderRadius: 10,
              padding: 14, marginBottom: 16, fontSize: 13, color: COLORS.green, lineHeight: 1.5,
            }}>
              <strong>Key finding:</strong> OpenClaw's existing file-based architecture maps remarkably well to our CAA.
              We only need to add 3 new bootstrap files (RAS.md, DMN.md, AMG.md) and one new folder (/learning/).
              Everything else can be built on existing primitives.
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {fileMapping.map((m, i) => (
                <div key={i} onClick={() => setExpandedMapping(expandedMapping === i ? null : i)}
                  style={{
                    background: COLORS.surface, borderRadius: 10, cursor: "pointer",
                    border: `1px solid ${expandedMapping === i ? m.color + "44" : COLORS.border}`,
                    overflow: "hidden",
                  }}>
                  <div style={{ padding: "12px 16px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <div style={{
                        fontFamily: "'JetBrains Mono', monospace", fontSize: 13, fontWeight: 700,
                        color: m.color, minWidth: 140,
                      }}>{m.caa}</div>
                      <span style={{ color: COLORS.textDim, fontSize: 16 }}>→</span>
                      <div style={{
                        fontFamily: "'JetBrains Mono', monospace", fontSize: 13, fontWeight: 600,
                        color: m.openclaw.includes("NEW") ? COLORS.amber : COLORS.text,
                      }}>{m.openclaw}</div>
                      <div style={{
                        marginLeft: "auto", fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 4,
                        background: m.openclaw.includes("NEW") ? `${COLORS.amber}22` : m.openclaw.includes("partial") ? `${COLORS.cyan}22` : `${COLORS.green}22`,
                        color: m.openclaw.includes("NEW") ? COLORS.amber : m.openclaw.includes("partial") ? COLORS.cyan : COLORS.green,
                      }}>
                        {m.openclaw.includes("NEW") ? "CREATE NEW" : m.openclaw.includes("partial") ? "EXTEND" : "EXISTS"}
                      </div>
                    </div>

                    {expandedMapping === i && (
                      <div style={{ marginTop: 12, fontSize: 12, lineHeight: 1.6 }}>
                        <div style={{ color: COLORS.textMuted, marginBottom: 8 }}>{m.notes}</div>
                        <div style={{
                          background: `${m.color}11`, padding: "8px 12px", borderRadius: 6,
                          borderLeft: `3px solid ${m.color}`, color: COLORS.text,
                        }}>
                          <strong style={{ color: m.color }}>Action:</strong> {m.action}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div style={{
              marginTop: 20, background: COLORS.surface, borderRadius: 12, padding: 18,
              border: `1px solid ${COLORS.border}`,
            }}>
              <h3 style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 700 }}>OpenClaw System Prompt Assembly (current)</h3>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, lineHeight: 2 }}>
                <div style={{ color: COLORS.textDim }}>{"// Injected into system prompt every turn:"}</div>
                <div><span style={{ color: COLORS.green }}>✓</span> <span style={{ color: COLORS.purple }}>AGENTS.md</span> <span style={{ color: COLORS.textDim }}>— operating rules</span></div>
                <div><span style={{ color: COLORS.green }}>✓</span> <span style={{ color: COLORS.purple }}>SOUL.md</span> <span style={{ color: COLORS.textDim }}>— persona/personality</span></div>
                <div><span style={{ color: COLORS.green }}>✓</span> <span style={{ color: COLORS.text }}>TOOLS.md</span> <span style={{ color: COLORS.textDim }}>— capabilities</span></div>
                <div><span style={{ color: COLORS.green }}>✓</span> <span style={{ color: COLORS.text }}>IDENTITY.md</span> <span style={{ color: COLORS.textDim }}>— name/vibe</span></div>
                <div><span style={{ color: COLORS.green }}>✓</span> <span style={{ color: COLORS.cyan }}>USER.md</span> <span style={{ color: COLORS.textDim }}>— user profile</span></div>
                <div><span style={{ color: COLORS.green }}>✓</span> <span style={{ color: COLORS.green }}>MEMORY.md</span> <span style={{ color: COLORS.textDim }}>— long-term memory</span></div>
                <div><span style={{ color: COLORS.green }}>✓</span> <span style={{ color: COLORS.pink }}>HEARTBEAT.md</span> <span style={{ color: COLORS.textDim }}>— periodic tasks</span></div>
                <div style={{ color: COLORS.textDim, marginTop: 4 }}>{"// We ADD:"}</div>
                <div><span style={{ color: COLORS.amber }}>+</span> <span style={{ color: COLORS.amber }}>RAS.md</span> <span style={{ color: COLORS.textDim }}>— attention filter (NEW)</span></div>
                <div><span style={{ color: COLORS.amber }}>+</span> <span style={{ color: COLORS.amber }}>DMN.md</span> <span style={{ color: COLORS.textDim }}>— self-model / inner narrative (NEW)</span></div>
                <div><span style={{ color: COLORS.amber }}>+</span> <span style={{ color: COLORS.amber }}>AMG.md</span> <span style={{ color: COLORS.textDim }}>— safety / skepticism layer (NEW)</span></div>
                <div><span style={{ color: COLORS.amber }}>+</span> <span style={{ color: COLORS.amber }}>SOP.md</span> <span style={{ color: COLORS.textDim }}>— standard procedures (NEW)</span></div>
                <div><span style={{ color: COLORS.amber }}>+</span> <span style={{ color: COLORS.amber }}>SOW.md</span> <span style={{ color: COLORS.textDim }}>— daily responsibilities (NEW)</span></div>
              </div>
            </div>
          </div>
        )}

        {view === "plan" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{
              background: `${COLORS.accent}11`, border: `1px solid ${COLORS.accent}33`,
              borderRadius: 12, padding: 18,
            }}>
              <h3 style={{ margin: "0 0 8px", fontSize: 15, fontWeight: 700, color: COLORS.accent }}>
                Strategy: Fork OpenClaw, Let the LLM Drive
              </h3>
              <p style={{ color: COLORS.textMuted, fontSize: 13, lineHeight: 1.6, margin: 0 }}>
                No programmatic RAS→DMN→AMG pipeline. All 5 Tier 1 documents are assembled into the system prompt 
                and the LLM naturally applies them during reasoning. OpenClaw already works this way — it injects 
                bootstrap files and trusts the model to follow them. We just add more bootstrap files with our cognitive layers.
              </p>
            </div>

            {[
              {
                phase: "Phase 1 — Fork & Setup",
                time: "Week 1",
                color: COLORS.green,
                tasks: [
                  "Fork OpenClaw repository",
                  "Add RAS.md, DMN.md, AMG.md, SOP.md, SOW.md to bootstrap file injection list in src/agents/system-prompt.ts",
                  "Use agent:bootstrap hook OR modify DEFAULT_BOOTSTRAP_FILES to include our new files",
                  "Create /learning/ folder structure in workspace",
                  "Write initial Constitution content in SOUL.md + AGENTS.md",
                  "Write initial RAS.md with attention filtering instructions",
                  "Write initial AMG.md with safety checkpoint (STATIC)",
                ],
              },
              {
                phase: "Phase 2 — Memory & DMN",
                time: "Week 2",
                color: COLORS.amber,
                tasks: [
                  "Install/adapt memory-complete skill for enhanced memory management",
                  "Build memory consolidation heartbeat task with 30%/70% recency weighting",
                  "Create initial DMN.md template with self-model and user-model sections",
                  "Build heartbeat task: DMN self-reflection and auto-update",
                  "Create /learning/ management skill (create notes, index, review)",
                  "Write SOP.md and SOW.md templates",
                ],
              },
              {
                phase: "Phase 3 — Integration & Testing",
                time: "Week 3",
                color: COLORS.purple,
                tasks: [
                  "Token budget audit — measure total Tier 1 injection size",
                  "Test RAS effectiveness: does the agent filter context better with RAS.md?",
                  "Test DMN: does the agent adapt approach based on user model?",
                  "Test AMG: does the agent catch safety issues and flag uncertainty?",
                  "Iterate on document content based on real conversations",
                  "Security hardening per CrowdStrike/Cisco recommendations",
                ],
              },
              {
                phase: "Phase 4 — Production & Refinement",
                time: "Week 4+",
                color: COLORS.pink,
                tasks: [
                  "Deploy to dedicated VPS or Mac Mini (not personal machine)",
                  "Connect preferred messaging channels",
                  "Monitor token usage and adjust document sizes",
                  "Build DMN drift detection (does self-model still align with Constitution?)",
                  "Create RAS→AMG feedback loop (when AMG rejects, inform RAS filtering)",
                  "Open-source CAA layer as OpenClaw skill pack",
                ],
              },
            ].map((phase, i) => (
              <div key={i} style={{
                background: COLORS.surface, borderRadius: 12, overflow: "hidden",
                border: `1px solid ${COLORS.border}`,
              }}>
                <div style={{
                  padding: "12px 18px", borderBottom: `1px solid ${COLORS.border}`,
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ width: 8, height: 8, borderRadius: 4, background: phase.color }} />
                    <span style={{ fontWeight: 700, fontSize: 14 }}>{phase.phase}</span>
                  </div>
                  <span style={{
                    fontSize: 11, color: phase.color, fontWeight: 600,
                    fontFamily: "'JetBrains Mono', monospace",
                  }}>{phase.time}</span>
                </div>
                <div style={{ padding: "12px 18px" }}>
                  {phase.tasks.map((t, j) => (
                    <div key={j} style={{
                      display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 6,
                      fontSize: 12, color: COLORS.textMuted, lineHeight: 1.5,
                    }}>
                      <span style={{ color: phase.color, fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, flexShrink: 0 }}>
                        {String(j + 1).padStart(2, '0')}
                      </span>
                      <span>{t}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}

            <div style={{
              background: COLORS.surface, borderRadius: 12, padding: 18,
              border: `1px solid ${COLORS.border}`,
            }}>
              <h3 style={{ margin: "0 0 10px", fontSize: 14, fontWeight: 700 }}>Minimal Code Changes Required</h3>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, lineHeight: 1.8, color: COLORS.textMuted }}>
                <div><span style={{ color: COLORS.amber }}>MODIFY</span> <span style={{ color: COLORS.text }}>src/agents/system-prompt.ts</span></div>
                <div style={{ paddingLeft: 24, color: COLORS.textDim }}>→ Add RAS.md, DMN.md, AMG.md, SOP.md, SOW.md to bootstrap file list</div>
                <div style={{ marginTop: 4 }}><span style={{ color: COLORS.green }}>CREATE</span> <span style={{ color: COLORS.text }}>workspace/RAS.md</span></div>
                <div><span style={{ color: COLORS.green }}>CREATE</span> <span style={{ color: COLORS.text }}>workspace/DMN.md</span></div>
                <div><span style={{ color: COLORS.green }}>CREATE</span> <span style={{ color: COLORS.text }}>workspace/AMG.md</span></div>
                <div><span style={{ color: COLORS.green }}>CREATE</span> <span style={{ color: COLORS.text }}>workspace/SOP.md</span></div>
                <div><span style={{ color: COLORS.green }}>CREATE</span> <span style={{ color: COLORS.text }}>workspace/SOW.md</span></div>
                <div><span style={{ color: COLORS.green }}>CREATE</span> <span style={{ color: COLORS.text }}>workspace/learning/</span> <span style={{ color: COLORS.textDim }}>folder</span></div>
                <div style={{ marginTop: 4 }}><span style={{ color: COLORS.amber }}>MODIFY</span> <span style={{ color: COLORS.text }}>workspace/HEARTBEAT.md</span></div>
                <div style={{ paddingLeft: 24, color: COLORS.textDim }}>→ Add memory consolidation + DMN update tasks</div>
                <div style={{ marginTop: 4 }}><span style={{ color: COLORS.cyan }}>OPTIONAL</span> <span style={{ color: COLORS.text }}>skills/caa-memory-consolidation/SKILL.md</span></div>
                <div><span style={{ color: COLORS.cyan }}>OPTIONAL</span> <span style={{ color: COLORS.text }}>skills/caa-learning-manager/SKILL.md</span></div>
              </div>
              <div style={{
                marginTop: 14, padding: "10px 14px", background: `${COLORS.green}11`,
                borderRadius: 6, fontSize: 12, color: COLORS.green, lineHeight: 1.5,
              }}>
                Total code change: ~1 file modified in source + 5 new markdown files + 2 optional skills.
                Everything else is content work (writing the actual document content for each cognitive layer).
              </div>
            </div>
          </div>
        )}

        <div style={{
          marginTop: 28, padding: "10px 16px", background: COLORS.surface,
          borderRadius: 8, border: `1px solid ${COLORS.border}`,
          fontSize: 11, color: COLORS.textDim, fontFamily: "'JetBrains Mono', monospace",
          display: "flex", justifyContent: "space-between",
        }}>
          <span>CAA × OpenClaw Analysis v1.0</span>
          <span>2026-03-06</span>
        </div>
      </div>
    </div>
  );
}
