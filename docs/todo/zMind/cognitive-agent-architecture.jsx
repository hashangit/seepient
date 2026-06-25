import { useState } from "react";

const COLORS = {
  bg: "#0a0e17",
  surface: "#111827",
  surfaceHover: "#1a2234",
  border: "#1e293b",
  borderActive: "#3b82f6",
  text: "#e2e8f0",
  textMuted: "#94a3b8",
  textDim: "#64748b",
  
  constitution: "#8b5cf6",
  ras: "#f59e0b",
  memory: "#10b981",
  dmn: "#3b82f6",
  amg: "#ef4444",
  heartbeat: "#ec4899",
  sop: "#6366f1",
  sow: "#14b8a6",
  learning: "#a78bfa",
  
  proceed: "#10b981",
  pause: "#f59e0b",
  abort: "#ef4444",
};

const docs = {
  constitution: {
    name: "Constitution.md",
    subtitle: "Prefrontal Cortex",
    color: COLORS.constitution,
    tier: 1,
    icon: "⚖️",
    desc: "Identity anchor. Defines who the agent is, behavioral principles, document interpretation rules, and conflict resolution hierarchy. The executive governance layer.",
    keys: ["Identity & persona", "Core principles", "Document interpretation rules", "Conflict resolution hierarchy", "Escalation protocols"],
    update: "Manual — by system designer",
  },
  ras: {
    name: "RAS.md",
    subtitle: "Reticular Activating System",
    color: COLORS.ras,
    tier: 1,
    icon: "🎯",
    desc: "Attention filter. Determines what information is relevant to the current query, scores context, suppresses noise, and flags anomalies.",
    keys: ["Signal detection protocol", "Relevance scoring (direct, indirect, temporal, source)", "Context window triage", "Anomaly detection", "Noise suppression"],
    update: "Semi-static — refined over time",
  },
  memory: {
    name: "MEMORY.md",
    subtitle: "Hippocampus",
    color: COLORS.memory,
    tier: 1,
    icon: "🧠",
    desc: "Episodic store. Living record of interactions, preferences, projects, and contextual knowledge. Weighted consolidation: 30% oldest → 70% newest.",
    keys: ["Active context (current session)", "Recent memories (7 days)", "Consolidated memories (older)", "Pinned memories (permanent)", "Daily consolidation with recency weighting"],
    update: "Continuous — appended each interaction, consolidated daily",
  },
  dmn: {
    name: "DMN.md",
    subtitle: "Default Mode Network",
    color: COLORS.dmn,
    tier: 1,
    icon: "💭",
    desc: "Inner narrative. The agent's self-model — how it perceives itself and the user. Builds personalized approach for each query through introspection.",
    keys: ["Self-model (auto-updated)", "User model (communication style, expertise, emotional state)", "Narrative construction", "Approach calibration", "Future simulation"],
    update: "Periodic — agent-generated, validated against Constitution",
  },
  amg: {
    name: "AMG.md",
    subtitle: "Amygdala",
    color: COLORS.amg,
    tier: 1,
    icon: "🛡️",
    desc: "Threat detector. Static safety layer forcing skepticism and methodical validation. Checks every output for safety, accuracy, ethics, and quality.",
    keys: ["Information trust hierarchy", "Safety rules (never/always)", "Escalation matrix (confidence × stakes)", "Manipulation detection", "Confidence calibration"],
    update: "STATIC — never modified by agent",
  },
  heartbeat: {
    name: "HEARTBEAT.md",
    subtitle: "Autonomous Pulse",
    color: COLORS.heartbeat,
    tier: 2,
    icon: "💓",
    desc: "Cron-triggered autonomous workflows. Memory consolidation, DMN self-model updates, learning folder review.",
    keys: ["6-hourly: Memory consolidation", "Daily: Summary + DMN update", "Weekly: Decay pass + learning review"],
    update: "Manual — by system designer",
  },
  sop: {
    name: "SOP.md",
    subtitle: "Standard Procedures",
    color: COLORS.sop,
    tier: 2,
    icon: "📋",
    desc: "User-defined workflows for specific task types. Trigger conditions, step-by-step procedures, expected outputs.",
    keys: ["Trigger conditions", "Step-by-step procedures", "Expected outputs", "Exception handling"],
    update: "Manual — by user",
  },
  sow: {
    name: "SOW.md",
    subtitle: "Statement of Work",
    color: COLORS.sow,
    tier: 2,
    icon: "📑",
    desc: "Daily routine and responsibilities. The agent's job description — what it's accountable for producing.",
    keys: ["Role summary", "Daily responsibilities", "Deliverables", "Boundaries"],
    update: "Manual — by user",
  },
};

const pipelineSteps = [
  { id: "input", label: "User Query", color: COLORS.textMuted, icon: "📥" },
  { id: "ras", label: "RAS Pass", color: COLORS.ras, icon: "🎯", desc: "Filter relevance, identify intent, triage context" },
  { id: "dmn", label: "DMN Pass", color: COLORS.dmn, icon: "💭", desc: "Build narrative, calibrate approach, model user" },
  { id: "reason", label: "Reasoning + Action", color: COLORS.text, icon: "⚡", desc: "Full LLM reasoning with enriched context" },
  { id: "amg", label: "AMG Checkpoint", color: COLORS.amg, icon: "🛡️", desc: "Validate safety, accuracy, ethics, quality" },
  { id: "output", label: "Output", color: COLORS.proceed, icon: "✅", desc: "PROCEED → respond to user" },
];

function DocCard({ docKey, doc, isSelected, onClick }) {
  return (
    <div
      onClick={onClick}
      style={{
        background: isSelected ? COLORS.surfaceHover : COLORS.surface,
        border: `1px solid ${isSelected ? doc.color : COLORS.border}`,
        borderRadius: 12,
        padding: "14px 16px",
        cursor: "pointer",
        transition: "all 0.2s ease",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {isSelected && (
        <div style={{
          position: "absolute", top: 0, left: 0, right: 0, height: 3,
          background: doc.color,
        }} />
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <span style={{ fontSize: 20 }}>{doc.icon}</span>
        <div style={{ flex: 1 }}>
          <div style={{ color: doc.color, fontWeight: 700, fontSize: 14, fontFamily: "'JetBrains Mono', monospace" }}>
            {doc.name}
          </div>
          <div style={{ color: COLORS.textDim, fontSize: 11, marginTop: 1 }}>{doc.subtitle}</div>
        </div>
        <span style={{
          background: doc.tier === 1 ? "rgba(59,130,246,0.15)" : "rgba(100,116,139,0.15)",
          color: doc.tier === 1 ? "#60a5fa" : COLORS.textDim,
          fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 99,
          fontFamily: "'JetBrains Mono', monospace",
        }}>
          TIER {doc.tier}
        </span>
      </div>
      {isSelected && (
        <div style={{ marginTop: 12 }}>
          <p style={{ color: COLORS.textMuted, fontSize: 13, lineHeight: 1.5, margin: "0 0 12px" }}>{doc.desc}</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {doc.keys.map((k, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ width: 4, height: 4, borderRadius: 2, background: doc.color, flexShrink: 0 }} />
                <span style={{ color: COLORS.text, fontSize: 12 }}>{k}</span>
              </div>
            ))}
          </div>
          <div style={{
            marginTop: 12, padding: "8px 10px", background: "rgba(255,255,255,0.03)",
            borderRadius: 6, fontSize: 11, color: COLORS.textDim,
          }}>
            Update: {doc.update}
          </div>
        </div>
      )}
    </div>
  );
}

function PipelineStep({ step, index, total }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 0 }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 10,
        background: COLORS.surface, border: `1px solid ${step.color}33`,
        borderRadius: 10, padding: "10px 16px", minWidth: 180,
      }}>
        <span style={{ fontSize: 18 }}>{step.icon}</span>
        <div>
          <div style={{ color: step.color, fontWeight: 700, fontSize: 13, fontFamily: "'JetBrains Mono', monospace" }}>
            {step.label}
          </div>
          {step.desc && <div style={{ color: COLORS.textDim, fontSize: 10, marginTop: 2, maxWidth: 200 }}>{step.desc}</div>}
        </div>
      </div>
      {index < total - 1 && (
        <div style={{ color: COLORS.textDim, fontSize: 18, padding: "0 4px" }}>→</div>
      )}
    </div>
  );
}

export default function CognitiveArchDiagram() {
  const [selectedDoc, setSelectedDoc] = useState("constitution");
  const [view, setView] = useState("documents");

  const tier1 = Object.entries(docs).filter(([, d]) => d.tier === 1);
  const tier2 = Object.entries(docs).filter(([, d]) => d.tier === 2);

  return (
    <div style={{
      background: COLORS.bg, color: COLORS.text, minHeight: "100vh",
      fontFamily: "'Inter', -apple-system, sans-serif", padding: "32px 24px",
    }}>
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet" />

      <div style={{ maxWidth: 960, margin: "0 auto" }}>
        <div style={{ marginBottom: 32 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 10,
              background: "linear-gradient(135deg, #3b82f6, #8b5cf6)",
              display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18,
            }}>🧬</div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em" }}>
              Cognitive Agent Architecture
            </h1>
          </div>
          <p style={{ color: COLORS.textDim, fontSize: 13, margin: "8px 0 0 48px" }}>
            Biologically-inspired AI agent system modelling RAS, DMN, and Amygdala
          </p>
        </div>

        <div style={{ display: "flex", gap: 4, marginBottom: 24, background: COLORS.surface, padding: 4, borderRadius: 10, width: "fit-content" }}>
          {[
            { id: "documents", label: "System Documents" },
            { id: "pipeline", label: "Processing Pipeline" },
            { id: "memory", label: "Memory Lifecycle" },
            { id: "tokens", label: "Token Budget" },
          ].map(tab => (
            <button key={tab.id} onClick={() => setView(tab.id)} style={{
              background: view === tab.id ? COLORS.surfaceHover : "transparent",
              border: view === tab.id ? `1px solid ${COLORS.border}` : "1px solid transparent",
              color: view === tab.id ? COLORS.text : COLORS.textDim,
              padding: "8px 16px", borderRadius: 8, cursor: "pointer",
              fontSize: 13, fontWeight: 500, transition: "all 0.15s",
            }}>
              {tab.label}
            </button>
          ))}
        </div>

        {view === "documents" && (
          <div>
            <div style={{ marginBottom: 20 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <div style={{ width: 8, height: 8, borderRadius: 4, background: "#3b82f6" }} />
                <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "#60a5fa" }}>
                  Tier 1 — Core Cognitive Layer
                </h3>
              </div>
              <p style={{ color: COLORS.textDim, fontSize: 12, margin: "2px 0 0 16px" }}>
                Injected into system prompt at every LLM call. Never in chat history.
              </p>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 24 }}>
              {tier1.map(([key, doc]) => (
                <DocCard key={key} docKey={key} doc={doc}
                  isSelected={selectedDoc === key}
                  onClick={() => setSelectedDoc(selectedDoc === key ? null : key)} />
              ))}
            </div>

            <div style={{ marginBottom: 20 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <div style={{ width: 8, height: 8, borderRadius: 4, background: COLORS.textDim }} />
                <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: COLORS.textMuted }}>
                  Tier 2 — Operational Layer
                </h3>
              </div>
              <p style={{ color: COLORS.textDim, fontSize: 12, margin: "2px 0 0 16px" }}>
                Loaded contextually or on schedule.
              </p>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 24 }}>
              {tier2.map(([key, doc]) => (
                <DocCard key={key} docKey={key} doc={doc}
                  isSelected={selectedDoc === key}
                  onClick={() => setSelectedDoc(selectedDoc === key ? null : key)} />
              ))}
            </div>

            <div style={{
              background: COLORS.surface, border: `1px solid ${COLORS.learning}33`,
              borderRadius: 12, padding: 16,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                <span style={{ fontSize: 18 }}>📚</span>
                <div>
                  <div style={{ color: COLORS.learning, fontWeight: 700, fontSize: 14, fontFamily: "'JetBrains Mono', monospace" }}>
                    /learning/ Folder
                  </div>
                  <div style={{ color: COLORS.textDim, fontSize: 11 }}>Agent-writable knowledge base</div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 16, fontSize: 12, color: COLORS.textMuted }}>
                <span>📁 topics/</span>
                <span>📁 resources/</span>
                <span>📁 reflections/weekly/</span>
                <span>📄 index.md</span>
              </div>
            </div>
          </div>
        )}

        {view === "pipeline" && (
          <div>
            <div style={{
              background: COLORS.surface, borderRadius: 12, padding: 24,
              border: `1px solid ${COLORS.border}`,
            }}>
              <h3 style={{ margin: "0 0 20px", fontSize: 15, fontWeight: 600 }}>Per-Query Processing Flow</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {pipelineSteps.map((step, i) => (
                  <div key={step.id} style={{ display: "flex", alignItems: "center" }}>
                    <div style={{
                      width: 32, display: "flex", flexDirection: "column", alignItems: "center", marginRight: 16,
                    }}>
                      <div style={{
                        width: 28, height: 28, borderRadius: 14,
                        background: `${step.color}22`, border: `2px solid ${step.color}`,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 13,
                      }}>{step.icon}</div>
                      {i < pipelineSteps.length - 1 && (
                        <div style={{ width: 2, height: 20, background: COLORS.border, marginTop: 4 }} />
                      )}
                    </div>
                    <div style={{
                      flex: 1, background: COLORS.surfaceHover, borderRadius: 8,
                      padding: "10px 16px", border: `1px solid ${step.color}22`,
                    }}>
                      <div style={{ color: step.color, fontWeight: 700, fontSize: 13, fontFamily: "'JetBrains Mono', monospace" }}>
                        {step.label}
                      </div>
                      {step.desc && <div style={{ color: COLORS.textMuted, fontSize: 12, marginTop: 2 }}>{step.desc}</div>}
                    </div>
                  </div>
                ))}
              </div>

              <div style={{ marginTop: 24, padding: 16, background: `${COLORS.amg}11`, borderRadius: 8, border: `1px solid ${COLORS.amg}22` }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.amg, marginBottom: 8 }}>AMG Verdict Routes</div>
                <div style={{ display: "flex", gap: 16 }}>
                  {[
                    { label: "PROCEED", color: COLORS.proceed, desc: "Output to user → write memory" },
                    { label: "PAUSE", color: COLORS.pause, desc: "Request clarification from user" },
                    { label: "ABORT", color: COLORS.abort, desc: "Refuse and explain why" },
                  ].map(v => (
                    <div key={v.label} style={{
                      flex: 1, padding: "8px 12px", borderRadius: 6,
                      background: `${v.color}11`, border: `1px solid ${v.color}33`,
                    }}>
                      <div style={{ color: v.color, fontWeight: 700, fontSize: 12, fontFamily: "'JetBrains Mono', monospace" }}>{v.label}</div>
                      <div style={{ color: COLORS.textDim, fontSize: 11, marginTop: 2 }}>{v.desc}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div style={{
              background: COLORS.surface, borderRadius: 12, padding: 24, marginTop: 16,
              border: `1px solid ${COLORS.border}`,
            }}>
              <h3 style={{ margin: "0 0 16px", fontSize: 15, fontWeight: 600 }}>System Prompt Assembly</h3>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, lineHeight: 1.8 }}>
                <div style={{ color: COLORS.textDim }}>{"// System prompt structure per LLM call"}</div>
                <div style={{ color: COLORS.constitution }}>{"[Constitution.md]"}</div>
                <div style={{ color: COLORS.ras }}>{"[RAS.md]"}</div>
                <div style={{ color: COLORS.memory }}>{"[MEMORY.md]"}</div>
                <div style={{ color: COLORS.dmn }}>{"[DMN.md]"}</div>
                <div style={{ color: COLORS.amg }}>{"[AMG.md]"}</div>
                <div style={{ color: COLORS.textDim, marginTop: 4 }}>{"// Conditionally:"}</div>
                <div style={{ color: COLORS.heartbeat, opacity: 0.6 }}>{"[HEARTBEAT.md]  // if cron trigger"}</div>
                <div style={{ color: COLORS.sop, opacity: 0.6 }}>{"[SOP.md]         // if task matches procedure"}</div>
                <div style={{ color: COLORS.sow, opacity: 0.6 }}>{"[SOW.md]         // if daily routine context"}</div>
                <div style={{ color: COLORS.textDim, marginTop: 8 }}>{"───────────────────────────────"}</div>
                <div style={{ color: COLORS.text }}>{"[Chat History — user + agent messages]"}</div>
              </div>
            </div>
          </div>
        )}

        {view === "memory" && (
          <div style={{
            background: COLORS.surface, borderRadius: 12, padding: 24,
            border: `1px solid ${COLORS.border}`,
          }}>
            <h3 style={{ margin: "0 0 20px", fontSize: 15, fontWeight: 600, color: COLORS.memory }}>Memory Lifecycle</h3>
            {[
              { label: "Interaction", desc: "Extract noteworthy info → append to Active Context", time: "Real-time", color: COLORS.memory },
              { label: "6-Hour Consolidation", desc: "Merge overlapping memories, remove redundancy", time: "Every 6h", color: COLORS.heartbeat },
              { label: "Daily Summary", desc: "Apply recency weighting: 30% oldest → 70% newest. Generate compressed summary.", time: "Daily", color: COLORS.dmn },
              { label: "Weekly Decay", desc: "Compress detail on old unreferenced memories. Archive beyond threshold.", time: "Weekly", color: COLORS.textDim },
            ].map((stage, i) => (
              <div key={i} style={{ display: "flex", alignItems: "flex-start", marginBottom: 20 }}>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginRight: 16, width: 24 }}>
                  <div style={{ width: 12, height: 12, borderRadius: 6, background: stage.color, border: `2px solid ${stage.color}` }} />
                  {i < 3 && <div style={{ width: 2, flex: 1, minHeight: 40, background: COLORS.border }} />}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ fontWeight: 700, fontSize: 14, color: stage.color }}>{stage.label}</span>
                    <span style={{
                      fontSize: 10, color: COLORS.textDim, background: "rgba(255,255,255,0.05)",
                      padding: "2px 8px", borderRadius: 4, fontFamily: "'JetBrains Mono', monospace",
                    }}>{stage.time}</span>
                  </div>
                  <div style={{ color: COLORS.textMuted, fontSize: 13, marginTop: 4 }}>{stage.desc}</div>
                </div>
              </div>
            ))}

            <div style={{
              marginTop: 16, padding: 16, background: `${COLORS.memory}11`,
              borderRadius: 8, border: `1px solid ${COLORS.memory}22`,
            }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.memory, marginBottom: 8 }}>
                Recency Weighting Formula
              </div>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 13, color: COLORS.text }}>
                weight = 0.3 + (0.4 × recency_score)
              </div>
              <div style={{ fontSize: 12, color: COLORS.textDim, marginTop: 6 }}>
                recency_score: 1.0 (today) → 0.0 (oldest in window)
              </div>
              <div style={{ display: "flex", gap: 4, marginTop: 12, alignItems: "flex-end", height: 60 }}>
                {Array.from({ length: 10 }, (_, i) => {
                  const recency = i / 9;
                  const weight = 0.3 + 0.4 * recency;
                  return (
                    <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                      <div style={{
                        width: "100%", height: weight * 60,
                        background: `rgba(16,185,129,${0.3 + weight * 0.7})`,
                        borderRadius: "3px 3px 0 0",
                      }} />
                      <span style={{ fontSize: 9, color: COLORS.textDim }}>{Math.round(weight * 100)}%</span>
                    </div>
                  );
                })}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: COLORS.textDim, marginTop: 4 }}>
                <span>← Oldest</span>
                <span>Newest →</span>
              </div>
            </div>
          </div>
        )}

        {view === "tokens" && (
          <div style={{
            background: COLORS.surface, borderRadius: 12, padding: 24,
            border: `1px solid ${COLORS.border}`,
          }}>
            <h3 style={{ margin: "0 0 20px", fontSize: 15, fontWeight: 600 }}>Token Budget (Tier 1)</h3>
            {[
              { name: "Constitution.md", tokens: 1000, color: COLORS.constitution },
              { name: "RAS.md", tokens: 800, color: COLORS.ras },
              { name: "MEMORY.md", tokens: 2000, color: COLORS.memory },
              { name: "DMN.md", tokens: 1000, color: COLORS.dmn },
              { name: "AMG.md", tokens: 800, color: COLORS.amg },
            ].map((doc, i) => (
              <div key={i} style={{ marginBottom: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: doc.color, fontFamily: "'JetBrains Mono', monospace" }}>
                    {doc.name}
                  </span>
                  <span style={{ fontSize: 12, color: COLORS.textDim, fontFamily: "'JetBrains Mono', monospace" }}>
                    ~{doc.tokens.toLocaleString()} tokens
                  </span>
                </div>
                <div style={{ height: 6, background: COLORS.bg, borderRadius: 3, overflow: "hidden" }}>
                  <div style={{
                    height: "100%", width: `${(doc.tokens / 2000) * 100}%`,
                    background: doc.color, borderRadius: 3, transition: "width 0.5s ease",
                  }} />
                </div>
              </div>
            ))}
            <div style={{
              marginTop: 20, padding: 12, background: "rgba(255,255,255,0.03)",
              borderRadius: 8, display: "flex", justifyContent: "space-between", alignItems: "center",
            }}>
              <span style={{ fontSize: 14, fontWeight: 700 }}>Total Tier 1</span>
              <span style={{ fontSize: 14, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: "#60a5fa" }}>
                ~5,600 tokens
              </span>
            </div>
            <p style={{ color: COLORS.textDim, fontSize: 12, marginTop: 12, lineHeight: 1.5 }}>
              Leaves the majority of context window for chat history and reasoning. If MEMORY.md exceeds budget,
              HEARTBEAT consolidation compresses oldest non-pinned memories first.
            </p>
          </div>
        )}

        <div style={{
          marginTop: 32, padding: "12px 16px", background: COLORS.surface,
          borderRadius: 8, border: `1px solid ${COLORS.border}`,
          display: "flex", justifyContent: "space-between", alignItems: "center",
        }}>
          <span style={{ fontSize: 11, color: COLORS.textDim, fontFamily: "'JetBrains Mono', monospace" }}>
            Cognitive Agent Architecture v1.0
          </span>
          <span style={{ fontSize: 11, color: COLORS.textDim }}>
            Compatible with LangGraph · Google ADK · Claude Agent SDK
          </span>
        </div>
      </div>
    </div>
  );
}
