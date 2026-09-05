<script setup lang="ts">
import { ref } from 'vue'

const surfaces = [
  { name: 'Terminal UI', hint: 'chat, diffs, approvals' },
  { name: 'CLI & REPL', hint: 'one-shot & piped runs' },
  { name: 'TypeScript SDK', hint: 'brings its own storage' },
  { name: 'Server API', hint: 'HTTP + WebSocket' },
]

const lanes = [
  {
    id: 'brain',
    kicker: 'The brain',
    tagline: 'decides what happens',
    items: [
      { name: 'Agent loop', desc: 'plans, acts, streams', featured: true },
      { name: 'Permission engine', desc: 'three consent modes' },
      { name: 'Model router', desc: 'right model per job' },
      { name: 'Hooks & middleware', desc: 'your code at safe points' },
      { name: 'Secret shield', desc: 'secrets stay redacted' },
    ],
  },
  {
    id: 'hands',
    kicker: 'The hands',
    tagline: 'acts on the world',
    items: [
      { name: 'Sandboxed execution', desc: 'OS jail + atomic commits', featured: true },
      { name: 'Built-in tools', desc: 'shell, files, web, email' },
      { name: 'MCP & OpenAPI gateway', desc: 'borrows outside tools' },
      { name: 'Media generators', desc: 'fal, Google, OpenAI' },
    ],
  },
  {
    id: 'memory',
    kicker: 'Memory',
    tagline: 'what it keeps',
    items: [
      { name: 'Session history', desc: 'every chat, resumable' },
      { name: 'Audit log', desc: 'one record per action', featured: true },
      { name: 'Credential vault', desc: 'OS keychain & OAuth' },
      { name: 'Skills', desc: 'playbooks on demand' },
      { name: 'Settings', desc: 'merged config layers' },
    ],
  },
]

const hovered = ref('')

function setHover(id: string) {
  hovered.value = id
}

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

    <!-- Surfaces -->
    <div class="surface-row" v-reveal>
      <div v-for="s in surfaces" :key="s.name" class="surface-chip">
        <span class="chip-name">{{ s.name }}</span>
        <span class="chip-hint">{{ s.hint }}</span>
      </div>
    </div>

    <!-- Animated flow connectors -->
    <div class="flow-zone" aria-hidden="true" v-reveal>
      <svg class="flow-svg" viewBox="0 0 1120 150" fill="none" preserveAspectRatio="none">
        <!-- drops from the four surfaces into the rail -->
        <path class="flow" d="M140 0 V52" />
        <path class="flow" d="M427 0 V52" />
        <path class="flow" d="M713 0 V52" />
        <path class="flow" d="M1000 0 V52" />
        <!-- rail -->
        <path class="flow flow--rail" d="M140 52 H1000" />
        <!-- drops from the rail into the three lanes -->
        <path class="flow" :class="{ 'flow--hot': hovered === 'brain' }" d="M186 52 V150" />
        <path class="flow" :class="{ 'flow--hot': hovered === 'hands' }" d="M560 52 V150" />
        <path class="flow" :class="{ 'flow--hot': hovered === 'memory' }" d="M934 52 V150" />
        <!-- arrowheads -->
        <path class="flow-head" d="M181 142 L186 150 L191 142" />
        <path class="flow-head" d="M555 142 L560 150 L565 142" />
        <path class="flow-head" d="M929 142 L934 150 L939 142" />
      </svg>
    </div>

    <!-- Lanes -->
    <div class="lane-row">
      <article
        v-for="lane in lanes"
        :key="lane.id"
        class="lane"
        :class="[`lane--${lane.id}`, { 'is-hovered': hovered === lane.id }]"
        v-reveal
        @mouseenter="setHover(lane.id)"
        @mouseleave="setHover('')"
      >
        <header class="lane-head">
          <p class="lane-kicker">{{ lane.kicker }}</p>
          <p class="lane-tagline">{{ lane.tagline }}</p>
        </header>
        <ul class="lane-items">
          <li v-for="item in lane.items" :key="item.name" class="lane-item" :class="{ 'is-featured': item.featured }">
            <span class="item-name">{{ item.name }}</span>
            <span class="item-desc">{{ item.desc }}</span>
          </li>
        </ul>
      </article>
    </div>

    <!-- Foundations substrate -->
    <div class="substrate" v-reveal>
      <span class="substrate-label">Foundations</span>
      <span class="substrate-desc">shared types · errors · contracts · settings schema — imported by every layer, importing no one</span>
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

/* Surfaces row */
.surface-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 14px;
  margin-top: 56px;
}

.surface-chip {
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: rgba(255, 255, 255, 0.6);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 13px 16px;
  transition: transform 0.25s ease, border-color 0.25s ease;
}

.surface-chip:hover {
  transform: translateY(-2px);
  border-color: rgba(19, 19, 17, 0.28);
}

.chip-name {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--ink);
}

.chip-hint {
  font-family: var(--vp-font-family-mono);
  font-size: 10.5px;
  color: var(--ink-3);
}

/* Connector zone */
.flow-zone {
  height: 132px;
  margin: 0 -32px;
}

.flow-svg {
  width: 100%;
  height: 100%;
  display: block;
}

.flow {
  stroke: rgba(19, 19, 17, 0.22);
  stroke-width: 1.25;
  stroke-dasharray: 4 6;
}

.flow--rail {
  stroke: rgba(95, 122, 61, 0.5);
  stroke-dasharray: 5 5;
}

.flow--hot {
  stroke: var(--moss);
  stroke-width: 1.75;
  stroke-dasharray: none;
}

.flow-head {
  stroke: rgba(19, 19, 17, 0.32);
  stroke-width: 1.25;
  fill: none;
}

@media (prefers-reduced-motion: no-preference) {
  .flow {
    animation: flow 1.6s linear infinite;
  }

  .flow--hot,
  .flow--rail {
    animation-duration: 1.1s;
  }

  @keyframes flow {
    to {
      stroke-dashoffset: -20;
    }
  }
}

/* Lanes */
.lane-row {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 18px;
  margin-top: 8px;
}

.lane {
  background: rgba(255, 255, 255, 0.55);
  border: 1px solid var(--line);
  border-radius: 16px;
  padding: 20px;
  transition: border-color 0.25s ease, box-shadow 0.25s ease, transform 0.25s ease;
}

.lane.is-hovered {
  border-color: rgba(95, 122, 61, 0.55);
  box-shadow: 0 20px 44px -26px rgba(19, 19, 17, 0.3);
  transform: translateY(-2px);
}

.lane--brain.is-hovered {
  border-color: rgba(95, 122, 61, 0.7);
}

.lane-head {
  padding-bottom: 14px;
  border-bottom: 1px solid var(--line);
}

.lane-kicker {
  margin: 0;
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
  font-weight: 550;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--moss-deep);
}

.lane--memory .lane-kicker {
  color: var(--ink-2);
}

.lane-tagline {
  margin: 4px 0 0;
  font-size: 12.5px;
  color: var(--ink-3);
}

.lane-items {
  list-style: none;
  margin: 0;
  padding: 0;
}

.lane-item {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 9px 0;
  border-bottom: 1px solid rgba(19, 19, 17, 0.07);
}

.lane-item:last-child {
  border-bottom: none;
  padding-bottom: 0;
}

.item-name {
  font-size: 13.5px;
  font-weight: 580;
  color: var(--ink);
  display: flex;
  align-items: center;
  gap: 8px;
}

.item-name::before {
  content: '';
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: rgba(19, 19, 17, 0.25);
  flex-shrink: 0;
}

.lane-item.is-featured .item-name::before {
  background: var(--moss);
}

.item-desc {
  font-family: var(--vp-font-family-mono);
  font-size: 10.5px;
  color: var(--ink-3);
  padding-left: 12px;
}

/* Foundations substrate */
.substrate {
  display: flex;
  align-items: baseline;
  gap: 18px;
  flex-wrap: wrap;
  margin-top: 18px;
  border: 1px dashed var(--line);
  border-radius: 12px;
  padding: 15px 20px;
  background: rgba(255, 255, 255, 0.35);
}

.substrate-label {
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
  font-weight: 550;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--ink-2);
}

.substrate-desc {
  font-family: var(--vp-font-family-mono);
  font-size: 10.5px;
  color: var(--ink-3);
}

/* Notes */
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
  .surface-row {
    grid-template-columns: repeat(2, 1fr);
  }

  .flow-zone {
    display: none;
  }

  .lane-row {
    grid-template-columns: 1fr;
    margin-top: 28px;
  }

  .layers-notes {
    grid-template-columns: 1fr;
    gap: 26px;
  }
}
</style>
