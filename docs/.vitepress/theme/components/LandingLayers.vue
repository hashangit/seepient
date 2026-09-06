<script setup>
const surfaces = ['Terminal UI (TUI)', 'CLI & REPL', 'Server API', 'Worker SDK']

const lanes = [
  {
    id: 'brain',
    title: 'The Brain',
    tagline: 'Decides what happens',
    items: ['Agent Loop', 'Model Router', 'Permission Engine', 'Approval Inbox', 'Skills', 'Secret Shield & Egress Gate'],
  },
  {
    id: 'hands',
    title: 'The Hands',
    tagline: 'Acts on the world',
    items: ['Sandboxed Execution (Seatbelt / Bubblewrap)', 'Rust Exact-Commit Broker', 'Built-in Tools', 'MCP Gateway'],
  },
  {
    id: 'memory',
    title: 'Memory',
    tagline: 'What it keeps',
    items: ['Session History', '0600 Audit Log', 'Settings', 'Credential Vault'],
  },
]

const notes = [
  {
    kicker: 'One-way imports',
    body: 'UI → Transport → Domain → Capabilities → Vendors. Nothing imports upward; no service SDK ever leaves the vendor quarantine.',
  },
  {
    kicker: 'One policy engine',
    body: 'All four surfaces delegate to the same agent loop and permission broker, so behavior never forks between terminal and server.',
  },
  {
    kicker: 'Shared foundations',
    body: 'Types, errors, contracts and settings schema live in foundations — imported by every layer, importing no one.',
  },
]
</script>

<template>
  <section class="lp-section layers">
    <header class="layers-head" v-reveal>
      <span class="lp-kicker">Architecture</span>
      <h2 class="lp-h2 layers-title">
        <span class="soft">One platform.</span><br />
        Multiple strict layers.
      </h2>
      <p class="lp-lede layers-lede">
        Prompts arrive through any surface and cross four one-way layers. Every
        decision is brokered, every effect is isolated, and everything that
        matters is kept.
      </p>
    </header>

    <div class="arch" v-reveal>
      <span class="arch-badge">SEPIENT CORE · RUNTIME MAP</span>

      <!-- Surfaces -->
      <div class="arch-region arch-region--surfaces">
        <p class="arch-region-title"><span class="tick" aria-hidden="true"></span>Surfaces</p>
        <p class="arch-region-tagline">Talk to it</p>
        <div class="arch-chips">
          <span v-for="s in surfaces" :key="s" class="arch-chip">{{ s }}</span>
        </div>
      </div>

      <div class="arch-link" aria-hidden="true">
        <span class="arch-link-line"></span>
        <span class="arch-link-head"></span>
      </div>

      <!-- The Brain -->
      <div class="arch-region arch-region--brain">
        <p class="arch-region-title"><span class="tick" aria-hidden="true"></span>The Brain</p>
        <p class="arch-region-tagline">Decides what happens</p>
        <div class="arch-chips">
          <span v-for="c in lanes[0].items" :key="c" class="arch-chip">{{ c }}</span>
        </div>
      </div>

      <div class="arch-link" aria-hidden="true">
        <span class="arch-link-line"></span>
        <span class="arch-link-head"></span>
      </div>

      <!-- The Hands -->
      <div class="arch-region arch-region--hands">
        <p class="arch-region-title"><span class="tick" aria-hidden="true"></span>The Hands</p>
        <p class="arch-region-tagline">Acts on the world</p>
        <div class="arch-chips">
          <span v-for="c in lanes[1].items" :key="c" class="arch-chip">{{ c }}</span>
        </div>
      </div>

      <div class="arch-link" aria-hidden="true">
        <span class="arch-link-line"></span>
        <span class="arch-link-head"></span>
      </div>

      <!-- Memory -->
      <div class="arch-region arch-region--memory">
        <p class="arch-region-title"><span class="tick" aria-hidden="true"></span>Memory</p>
        <p class="arch-region-tagline">What it keeps</p>
        <div class="arch-chips">
          <span v-for="c in lanes[2].items" :key="c" class="arch-chip">{{ c }}</span>
        </div>
      </div>

      <!-- Foundations substrate -->
      <div class="arch-foundations">
        <span class="arch-foundations-label">FOUNDATIONS</span>
        <span class="arch-foundations-desc">shared types · errors · contracts · settings — imported by every layer, importing no one</span>
      </div>
    </div>

    <div class="layers-notes">
      <div v-for="note in notes" :key="note.kicker" class="layers-note" v-reveal>
        <p class="note-kicker">{{ note.kicker }}</p>
        <p class="note-body">{{ note.body }}</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.layers {
  padding-top: 130px;
}

.layers-head {
  max-width: 620px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 22px;
}

.layers-lede {
  margin-top: 2px;
}

/* ------------------------------------------------------------------
 * Instrument panel — archify dark mode: slate canvas, faint grid,
 * kind-coded strokes, mono labels, dashed flow.
 * ------------------------------------------------------------------ */

.arch {
  position: relative;
  margin-top: 48px;
  background:
    linear-gradient(rgba(30, 41, 59, 0.33) 1px, transparent 1px),
    linear-gradient(90deg, rgba(30, 41, 59, 0.33) 1px, transparent 1px),
    linear-gradient(160deg, #0d1526, #070c18 65%);
  background-size: 28px 28px, 28px 28px, cover;
  border: 1px solid #1e293b;
  border-radius: 16px;
  padding: 34px 34px 30px;
  box-shadow: 0 40px 90px -40px rgba(7, 12, 24, 0.75);
}

.arch-badge {
  position: absolute;
  top: 14px;
  right: 16px;
  font-family: var(--vp-font-family-mono);
  font-size: 9.5px;
  letter-spacing: 0.18em;
  color: #475569;
}

.arch-region {
  border: 1px solid;
  border-radius: 10px;
  background: rgba(15, 23, 42, 0.55);
  padding: 18px 22px 20px;
  transition: border-color 0.25s ease, box-shadow 0.25s ease, transform 0.25s ease;
}

.arch-region:hover {
  transform: translateY(-2px);
}

.arch-region--surfaces { border-color: rgba(34, 211, 238, 0.38); }
.arch-region--surfaces:hover { border-color: #22d3ee; box-shadow: 0 0 32px -10px rgba(34, 211, 238, 0.45); }

.arch-region--brain { border-color: rgba(52, 211, 153, 0.38); }
.arch-region--brain:hover { border-color: #34d399; box-shadow: 0 0 32px -10px rgba(52, 211, 153, 0.45); }

.arch-region--hands { border-color: rgba(251, 191, 36, 0.38); }
.arch-region--hands:hover { border-color: #fbbf24; box-shadow: 0 0 32px -10px rgba(251, 191, 36, 0.4); }

.arch-region--memory { border-color: rgba(167, 139, 250, 0.4); }
.arch-region--memory:hover { border-color: #a78bfa; box-shadow: 0 0 32px -10px rgba(167, 139, 250, 0.45); }

.arch-region-title {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0;
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: #e2e8f0;
}

.tick {
  width: 8px;
  height: 8px;
  border-left: 2px solid currentColor;
  border-top: 2px solid currentColor;
  opacity: 0.7;
}

.arch-region--surfaces .tick { color: #22d3ee; }
.arch-region--brain .tick { color: #34d399; }
.arch-region--hands .tick { color: #fbbf24; }
.arch-region--memory .tick { color: #a78bfa; }

.arch-region-tagline {
  margin: 6px 0 0 18px;
  font-size: 13px;
  color: #94a3b8;
}

.arch-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 9px;
  margin: 14px 0 0 18px;
}

.arch-chip {
  font-family: var(--vp-font-family-mono);
  font-size: 11.5px;
  color: #cbd5e1;
  background: rgba(2, 6, 23, 0.5);
  border: 1px solid rgba(148, 163, 184, 0.28);
  border-radius: 7px;
  padding: 5px 12px;
  transition: border-color 0.2s ease, color 0.2s ease;
}

.arch-region:hover .arch-chip {
  border-color: rgba(148, 163, 184, 0.5);
  color: #e2e8f0;
}

.arch-region--surfaces:hover .arch-chip { border-color: rgba(34, 211, 238, 0.5); }
.arch-region--brain:hover .arch-chip { border-color: rgba(52, 211, 153, 0.5); }
.arch-region--hands:hover .arch-chip { border-color: rgba(251, 191, 36, 0.5); }
.arch-region--memory:hover .arch-chip { border-color: rgba(167, 139, 250, 0.5); }

/* Dashed flow connectors with triangle heads */
.arch-link {
  position: relative;
  height: 42px;
  width: 2px;
  margin: 4px auto;
  display: flex;
  justify-content: center;
}

.arch-link-line {
  position: absolute;
  inset: 2px 0 8px;
  background-image: linear-gradient(#64748b 45%, transparent 0);
  background-size: 2px 9px;
  background-repeat: repeat-y;
}

@media (prefers-reduced-motion: no-preference) {
  .arch-link-line {
    animation: arch-flow 0.9s linear infinite;
  }

  @keyframes arch-flow {
    to {
      background-position: 0 9px;
    }
  }
}

.arch-link-head {
  position: absolute;
  bottom: 0;
  width: 0;
  height: 0;
  border-left: 5px solid transparent;
  border-right: 5px solid transparent;
  border-top: 7px solid #64748b;
}

/* Foundations substrate */
.arch-foundations {
  margin-top: 26px;
  border: 1px dashed rgba(148, 163, 184, 0.4);
  border-radius: 10px;
  padding: 14px 20px;
  display: flex;
  align-items: baseline;
  gap: 16px;
  flex-wrap: wrap;
}

.arch-foundations-label {
  font-family: var(--vp-font-family-mono);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.18em;
  color: #94a3b8;
}

.arch-foundations-desc {
  font-family: var(--vp-font-family-mono);
  font-size: 10.5px;
  color: #64748b;
}

/* Notes below the panel */
.layers-notes {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 44px;
  margin-top: 56px;
  border-top: 1px solid var(--line);
  padding-top: 40px;
}

.note-kicker {
  margin: 0;
  font-family: var(--vp-font-family-mono);
  font-size: 10px;
  font-weight: 550;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--moss-deep);
}

.note-body {
  margin: 10px 0 0;
  font-size: 13.5px;
  line-height: 1.68;
  color: var(--ink-2);
}

@media (max-width: 960px) {
  .arch {
    padding: 24px 18px 22px;
  }

  .layers-notes {
    grid-template-columns: 1fr;
    gap: 26px;
  }
}
</style>
