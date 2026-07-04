# 08 — Cortex (long-term memory)

> **The SeepientAgent's own long-term memory store: episodic, semantic, and relational. Distinct from the code-context dual-graph MCP. Populated exclusively by Dreaming; retrieved online and scored by RAS.**
> Component deep-dive. Depends on `01-architecture.md`, `04-ras.md`, `07-memory-short.md`. Role: `long-term-memory`.

---

## 0. The non-negotiable distinction (read first)

There are **two graph systems in this codebase** and they must never be confused:

| System | Owner | Contents | Purpose | Lifecycle |
|---|---|---|---|---|
| **Dual-graph MCP** (existing) | The *developer agent* writing Zoe's code | Code files, symbols, imports, edit history | Lets *me* navigate the Zoe codebase efficiently | Maintained by the MCP's scan/register tools |
| **Cortex** (this doc, net-new) | Each *SeepientAgent instance* | Conversational entities, events, facts, relationships, episodic chunks | The instance's own autobiography and knowledge | Populated by Dreaming, per-instance |

The Cortex is **net-new infrastructure**, not a reuse of the MCP. They are different data, different ontologies, different owners, different lifecycles. The earlier conflation of these (in the discussion that produced this doc set) was a mistake; this section exists to prevent it recurring. The Cortex may *borrow implementation patterns* from the MCP (a local graph + vector store), but it is a separate store per-instance.

---

## 1. Brain analogy — and why it's exact

The Cortex maps to the **neocortex + hippocampal consolidation system** in its long-term-memory role. Three properties make the analogy exact:

1. **Stable, vast, consolidated.** Long-term memories live in the cortex, not the hippocampus. They are stable (not wiped per-session), vast (capacity for a lifetime), and consolidated (summarized, schema-organized, not verbatim transcripts). The Cortex is the instance's permanent memory: episodic (what happened), semantic (facts/concepts), and relational (entities and their relationships).
2. **Consolidated offline, not recorded live.** In the brain, experiences land in the hippocampus first and are transferred to cortex during sleep/replay. The Cortex is populated **exclusively by Dreaming**, never by a live turn. The Hippocampus (`07`) is the live buffer; the Cortex is what Dreaming writes from it. This phase transition is the hippocampal→cortical transfer.
3. **Schema-organized and retrievable, not exhaustive.** Cortical memory is not a recording; it's a schema of entities, facts, and episodes, retrieved by association. The Cortex is a graph (entities/relationships) + vectors (semantic/episodic chunks) + notes (declarative facts), retrieved by association and scored by RAS. You don't "play back" a memory; you reconstruct the relevant parts.

The three sub-stores map to three memory taxonomies:

| Sub-store | Memory type | Neural basis | Holds |
|---|---|---|---|
| `graph/` | Relational + semantic | Association cortices | Entities, concepts, and their relationships |
| `vector/` | Episodic + semantic | Neocortical episode representations | Embeddings of conversation chunks and document chunks |
| `notes/` | Declarative (learning folder) | Semantic memory | The agent's structured study notes — facts/concepts it has learned |

---

## 2. Functional role in the BMI

1. **Autobiography.** What has happened in this instance's history — projects, sessions, decisions, outcomes. This is what makes an instance continuous rather than stateless.
2. **Knowledge.** Facts and concepts the instance has accumulated about its user, its domain, its tools.
3. **Retrieval substrate for RAS.** Online, RAS retrieves from the Cortex (via graph traversal + vector search + notes lookup) to build the candidate context set that RAS then scores and filters. The Cortex is the long-term store RAS pulls from.
4. **Input to reflection.** DMN and Persona reflection (`05`, `06`) consume Cortex summaries — the instance reflects on its own consolidated history.

---

## 3. Time-scale & activation

- **Online (retrieval):** per-call, inside `bmiContextMiddleware`, before RAS scores. Target: graph traversal < 70ms, vector search < 130ms, total < 200ms.
- **Offline (population):** during Dreaming only. The Cortex is never written by a live turn.

---

## 4. Contract

### 4.1 Sources

```
.seepient/cortex/
├── graph/        # relational + semantic — per-instance
│   ├── nodes.jsonl      # Entity / Concept / Event / File / Strategy nodes
│   └── edges.jsonl      # typed relationships
├── vector/       # episodic + semantic chunks — per-instance
│   ├── chunks.jsonl     # { id, text, embedding, source-session, timestamp }
│   └── index.bin        # vector index (e.g. HNSW / flat for small sets)
└── notes/        # declarative learning folder — per-instance
    ├── index.md         # auto-maintained TOC
    ├── topics/          # structured study notes by topic
    └── reflections/     # weekly/insight notes
```

Per-instance. A second SeepientAgent has its own `cortex/`. The Cortex is the most per-instance thing in the system — it *is* the instance's memory.

### 4.2 Graph ontology

Node types (closed set, extensible only via doc change):

| Node type | Properties | Examples |
|---|---|---|
| `Entity` | name, aliases, description, first_seen, last_updated | "User", "Postgres", "Auth Module" |
| `Concept` | name, description | "rate limiting", " eventual consistency" |
| `File` | path, type, summary, hash | code/docs the instance worked on |
| `Event` | timestamp, type, outcome_summary | "Debug Session 2026-06-20", "Refactor Auth" |
| `Strategy` | name, description, when_to_use | "Revert-to-green when build fails" |

Edge types (closed set):

| Edge | From → To | Meaning |
|---|---|---|
| `RELATES_TO` | Entity ↔ Entity/Concept | general association |
| `DEPENDS_ON` | File → File | code/doc dependency |
| `INVOLVED` | Event → Entity/File | what an event touched |
| `RESOLVED` | Strategy → Event | a strategy solved an event |
| `CONTRADICTS` | Entity → Entity | conflicting info over time (critical for AMG) |
| `PREFERS` | Entity (User) → Concept/Strategy | user preference (from Persona/DMN) |

The `CONTRADICTS` edge is first-class: when new information contradicts old, both are kept and linked. AMG/RAS can surface contradictions as salience signals (`03`, `04`).

### 4.3 Runtime types

```typescript
// src/core/bmi/cortex/index.ts

interface Cortex {
  graph: GraphStore;
  vector: VectorStore;
  notes: NotesStore;
}

// ── Graph ─────────────────────────────────────────────
interface GraphStore {
  upsertNode(node: GraphNode): Promise<void>;        // Dreaming only
  upsertEdge(edge: GraphEdge): Promise<void>;        // Dreaming only
  query(query: GraphQuery): Promise<GraphResult>;     // online retrieval
}

interface GraphQuery {
  seeds: string[];                  // entity names / keywords from the prompt
  hops: number;                     // traversal depth (default 2-3)
  edgeTypes?: GraphEdgeType[];      // filter
}

interface GraphResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ── Vector ────────────────────────────────────────────
interface VectorStore {
  upsertChunk(chunk: Chunk): Promise<void>;          // Dreaming only
  search(embedding: number[], k: number): Promise<Chunk[]>;  // online
}

interface Chunk {
  id: string;
  text: string;
  embedding: number[];               // precomputed
  sourceSession: string;
  timestamp: number;
}

// ── Notes ─────────────────────────────────────────────
interface NotesStore {
  read(topic: string): Promise<string | null>;        // online, on-demand
  write(topic: string, content: string): Promise<void>; // Dreaming only
  list(): Promise<string[]>;                           // for the catalog
}

// ── Retrieval (called by bmiContextMiddleware, feeds RAS) ──
/**
 * Retrieve candidate context for a prompt. LLM-free.
 * 1. Keyword/entity extraction from the prompt (regex/NLP, cheap)
 * 2. Graph traversal from seeds (2-3 hops)
 * 3. Vector search top-K (needs prompt embedding — one embedding call, not an LLM call)
 * 4. Notes lookup if a topic is detected
 * Returns a candidate set; RAS scores/filters it.
 */
export async function retrieve(
  cortex: Cortex,
  prompt: string,
  promptEmbedding: number[],
  budget: RetrievalBudget,
): Promise<ScoreableItem[]>;
```

The critical property for the online path: **retrieval is LLM-free.** Graph traversal is set operations; vector search is nearest-neighbor on a precomputed index; the only model touch is a single embedding call for the prompt (not a generation call). This is what keeps the per-call cost tractable and is the direct analog of the "LLM-free graph retrieval" idea from the original zMind draft — done correctly, as the instance's own store.

### 4.4 The embedding cost boundary
- Items get embeddings **at Dreaming write time**, not at retrieval time. Retrieval only embeds the *prompt* (one call).
- For instances without an embedding provider configured, the vector store degrades gracefully (graph + notes still work; semantic search disabled). The Cortex must be functional on graph+notes alone, with vector as an enhancement.

---

## 5. Integration with the existing agent loop

### 5.1 Online retrieval (no loop change)
`retrieve()` runs inside `bmiContextMiddleware`, before RAS. The retrieved `ScoreableItem[]` is handed to `filterContext()` (RAS). The loop sees only the final filtered context in the system message.

### 5.2 Offline population (Dreaming, separate runAgentLoop)
Dreaming writes to the Cortex. This is an offline operation (`10`), not a loop operation. The Cortex stores are append/upsert-only from Dreaming; no live turn writes to them.

### 5.3 Relationship to the existing session store
The session store (`session-store.ts`) remains the source-of-truth for raw conversation transcripts. The Cortex is the *consolidated* memory derived from those transcripts by Dreaming. The Cortex does not replace the session store; it's the indexed, schema-organized, retrievable view that RAS can query efficiently.

---

## 6. Weight → mechanism mapping

### 6.1 Weight → framing strength
Base 0.6 → `guidance` ("Guidance that shapes your approach"). Cortex content is background context, not foreground authority. Lower framing than working memory.

### 6.2 Mode column
```
                base   release   explorative   creative
cortex weight   0.60   0.60      0.70          0.70
```
Slightly higher in explorative/creative (more background knowledge is useful when exploring/brainstorming). Mostly stable — long-term memory is background regardless of mode.

### 6.3 Token-budget rank: 6
Lower priority. Under pressure, Cortex content is the first to be summarized/dropped after Persona. The Cortex is vast; only the most salient slice should reach the window anyway (RAS has already filtered).

### 6.4 Authority: no veto
`veto: never`. Memory informs; it doesn't block. (AMG *uses* memory — a `CONTRADICTS` edge can be a threat signal — but that's AMG's authority, not the Cortex's.)

### 6.5 The "trust but verify" rule
Cortex content carries AMG valence tags like any context. Old memories can be stale; AMG's trust hierarchy puts memory at level 3 ("trust but verify if stale"). The Cortex never asserts itself as verified-truth; RAS/AMG treat it as strong-but-recheckable context.

---

## 7. Evolvability

**`evolvable: true`** (populated by Dreaming), gate `conscience`. The Cortex grows as the instance accumulates history. Controls:

1. **Conscience gate on writes.** A proposed Cortex write (a new node, a contradiction edge) is conscience-validated — e.g. a write that asserts a value-violating "fact" is rejected.
2. **Consolidation, not accumulation.** Dreaming doesn't just append; it consolidates — merges overlapping nodes, resolves contradictions (keeping the `CONTRADICTS` edge), decays stale unreferenced entries. The Cortex is curated, not a dump.
3. **Pinning.** Critical facts (hard user constraints, key decisions) can be pinned so consolidation never decays them.
4. **Size governance.** A Cortex that grows without bound degrades retrieval. Consolidation includes a decay pass (archive/drop old unreferenced non-pinned nodes) governed by a size budget.

---

## 8. Multi-instance implications

- **Entirely per-instance.** The Cortex is the instance's memory; two instances have completely separate Cortexes.
- **Portability.** A Cortex is a directory; an instance's memory is theoretically portable/exportable (future work: export/import). This is the "what if I want to back up or move my SeepientAgent" story.

---

## 9. Verification (anti-theatre)

### 9.1 Retrieval correctness (`cortex-retrieval-quality`)
- **Needle:** a prompt whose answer depends on a fact in the Cortex. Target: retrieved in top-K, ≥ 90%.
- **Contradiction surfacing:** when the Cortex has a `CONTRADICTS` edge relevant to the prompt, both nodes are retrieved and AMG flags the contradiction. Integration test.
- **No hallucinated edges:** the graph contains only what Dreaming wrote; retrieval never invents relationships.

### 9.2 LLM-free retrieval cost (`cortex-latency`)
- Graph traversal + vector search on a 10k-node/10k-chunk Cortex: p95 < 200ms. The LLM-free premise is load-bearing; if it's slow, the design fails.

### 9.3 Consolidation quality (`cortex-consolidation`)
- Over Dreaming cycles, the Cortex converges (merges duplicates, resolves contradictions) rather than growing unboundedly. Target: duplicate-node rate decreases; contradiction edges get resolved or annotated.
- Stale decay: unreferenced old non-pinned nodes are archived at the configured rate.

### 9.4 Retrieval improves outcomes (`cortex-effect`)
- Paired comparison: with Cortex retrieval vs without. On multi-session tasks ("remember last week we decided X"), does the instance recall correctly? Target: significantly better with Cortex.
- **This is the test that proves long-term memory is doing something a stateless agent can't.**

### 9.5 Conscience gating
- A Cortex write asserting a value-violating fact is rejected at the gate. Target: 100% on a probe suite.

### 9.6 Observable signals
- Retrieval logs: nodes/chunks returned, latency. Write logs: nodes/edges added/merged/decayed per Dreaming cycle. A Cortex that never grows (Dreaming broken) or grows linearly without consolidation (decay broken) is flagged.

---

## 10. Open questions & risks

1. **Retrieval quality without a strong embedding model.** If no embedding provider is configured, semantic search is off and retrieval relies on graph+notes+lexical. Quality drops. Mitigation: graph+notes must carry the load; vector is enhancement. The eval suite must run in both modes.
2. **Graph ontology drift.** As the instance accumulates niche entities, the ontology may need extension. Closed set + doc change is the discipline; ad-hoc node types are rejected.
3. **Consolidation is hard.** Merging overlapping nodes, resolving contradictions, and deciding what to decay are themselves LLM-assisted judgments during Dreaming. Their quality determines Cortex quality. This is the single biggest quality risk in the Cortex and the place most engineering effort goes.
4. **Privacy & sensitivity.** The Cortex contains the user's history. It must respect the same privacy posture as the session store. Sensitive content handling (what gets consolidated vs forgotten) is a conscience-adjacent concern — the Conscience may include "forget sensitive content on request" obligations.
5. **Cold start.** A new instance has an empty Cortex. Retrieval returns little; the instance behaves near-statelessly until Dreaming has run a few times. Acceptable, but the UX should set expectations.
6. **The dual-graph confusion, permanently.** Anyone reading this codebase will see "graph" in two places. The §0 distinction must be in code comments, not just this doc. The Cortex module namespace (`src/core/bmi/cortex/`) and clear naming are the defense.

---

*Depends on: `00-overview.md`, `01-architecture.md`, `03-amg.md` (valence tags on Cortex items), `04-ras.md` (RAS scores Cortex output), `07-memory-short.md` (Dreaming reads working memory to write Cortex).*
*Referenced by: `05-dmn.md` and `06-persona.md` (consume Cortex summaries), `10-evolution-system.md` (Dreaming populates the Cortex), `11-evaluation-framework.md` (the cortex-* eval suites).*
