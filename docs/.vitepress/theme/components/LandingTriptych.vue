<script setup lang="ts">
import { withBase } from 'vitepress'

const cards = [
  {
    key: 'blue',
    image: `${withBase('/textures/aurora-blue.jpg')}`,
    theme: 'light',
    title: 'Permission broker',
    rows: [
      { label: 'fs.write', value: 'session', tone: 'ok' },
      { label: 'net.fetch', value: 'ask', tone: 'warn' },
      { label: 'secret.ref', value: 'withheld', tone: 'mute' },
    ],
    caption: 'Nothing runs until policy says so.',
  },
  {
    key: 'green',
    image: `${withBase('/textures/aurora-green.jpg')}`,
    theme: 'dark',
    title: 'Purpose routing',
    rows: [
      { label: 'language · complex', value: 'sonnet', tone: 'ok' },
      { label: 'vision · standard', value: 'gemini', tone: 'ok' },
      { label: 'commit · efficient', value: 'haiku', tone: 'ok' },
    ],
    caption: 'Models assigned per purpose and tier.',
  },
  {
    key: 'sand',
    image: `${withBase('/textures/aurora-sand.jpg')}`,
    theme: 'light',
    title: 'Audit trail',
    ledger: [
      { time: '12:04:11', op: 'fs.write', verdict: 'allow' },
      { time: '12:04:12', op: 'net.fetch', verdict: 'deny' },
      { time: '12:04:15', op: 'shell', verdict: 'allow' },
    ],
    caption: 'Every decision, append-only.',
  },
]

const pillars = [
  {
    idx: '[01]',
    title: 'Every action, brokered',
    body: 'Tools do not run until the policy engine says so. Capabilities are granted, escalated, and audited per action — in the terminal or over the wire.',
  },
  {
    idx: '[02]',
    title: 'Isolated to the kernel',
    body: 'Shell and file effects run inside Seatbelt or Bubblewrap profiles, and writes land through a Rust commit helper that verifies pre-images atomically.',
  },
  {
    idx: '[03]',
    title: 'Routed by purpose',
    body: 'Models are picked per purpose and tier — standard, complex, efficient — from a live provider catalog, never a hardcoded list.',
  },
]
</script>

<template>
  <section class="lp-section triptych">
    <header class="triptych-head" v-reveal>
      <h2 class="lp-h2">
        <span class="soft">Clarity and control</span><br />
        for every action the model takes.
      </h2>
      <p class="lp-lede triptych-lede">
        An agent that can touch your system needs more than a prompt. Seepient
        brokers capability, verifies every write, and records what happened.
      </p>
    </header>

    <div class="triptych-pillars">
      <div v-for="p in pillars" :key="p.idx" class="pillar" v-reveal>
        <span class="lp-idx">{{ p.idx }}</span>
        <h3 class="pillar-title">{{ p.title }}</h3>
        <p class="pillar-body">{{ p.body }}</p>
      </div>
    </div>

    <div class="triptych-cards">
      <article
        v-for="card in cards"
        :key="card.key"
        class="tcard"
        v-reveal
        :style="{ backgroundImage: `url(${card.image})` }"
      >
        <div class="tcard-panel" :class="`tcard-panel--${card.theme}`">
          <p class="tcard-title">
            <span class="tcard-dot" aria-hidden="true"></span>
            {{ card.title }}
          </p>

          <ul v-if="card.rows" class="tcard-rows">
            <li v-for="row in card.rows" :key="row.label">
              <span class="tcell-label">{{ row.label }}</span>
              <span class="tcell-chip" :class="`tone--${row.tone}`">{{ row.value }}</span>
            </li>
          </ul>

          <ul v-if="card.ledger" class="tcard-ledger">
            <li v-for="entry in card.ledger" :key="entry.time">
              <span class="led-time">{{ entry.time }}</span>
              <span class="led-op">{{ entry.op }}</span>
              <span class="led-verdict" :class="entry.verdict === 'deny' ? 'led-verdict--deny' : 'led-verdict--allow'">{{ entry.verdict }}</span>
            </li>
          </ul>

          <p class="tcard-caption">{{ card.caption }}</p>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.triptych-head {
  display: grid;
  grid-template-columns: 1.25fr 0.75fr;
  gap: 48px;
  align-items: end;
}

.triptych-lede {
  max-width: 380px;
  justify-self: end;
}

.triptych-pillars {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 44px;
  margin-top: 72px;
}

.pillar-title {
  font-family: var(--vp-font-family-heading);
  font-size: 1.06rem;
  font-weight: 640;
  letter-spacing: -0.015em;
  color: var(--ink);
  margin: 10px 0 0;
}

.pillar-body {
  font-size: 13.5px;
  line-height: 1.68;
  color: var(--ink-2);
  margin: 8px 0 0;
}

.triptych-cards {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 18px;
  margin-top: 56px;
}

.tcard {
  position: relative;
  min-height: 400px;
  border-radius: 18px;
  overflow: hidden;
  background-size: cover;
  background-position: center;
  border: 1px solid rgba(19, 19, 17, 0.08);
}

.tcard-panel {
  position: absolute;
  left: 18px;
  right: 18px;
  bottom: 18px;
  border-radius: 13px;
  padding: 16px 18px;
  backdrop-filter: var(--glass-filter);
  -webkit-backdrop-filter: var(--glass-filter);
}

.tcard-panel--light {
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  box-shadow: var(--glass-shadow);
  color: var(--ink);
}

.tcard-panel--dark {
  background: linear-gradient(115deg, rgba(15, 18, 10, 0.66), rgba(15, 18, 10, 0.45) 60%, rgba(15, 18, 10, 0.58));
  border: 1px solid rgba(255, 255, 255, 0.3);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.18), 0 24px 48px -24px rgba(0, 0, 0, 0.5);
  color: rgba(243, 243, 240, 0.92);
}

.tcard-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 12px;
  font-family: var(--vp-font-family-mono);
  font-size: 10px;
  font-weight: 550;
  letter-spacing: 0.15em;
  text-transform: uppercase;
}

.tcard-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.65;
}

.tcard-rows {
  list-style: none;
  margin: 0;
  padding: 0;
}

.tcard-rows li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 0;
  border-top: 1px solid rgba(127, 127, 117, 0.18);
  font-family: var(--vp-font-family-mono);
  font-size: 11.5px;
}

.tcell-label {
  opacity: 0.85;
}

.tcell-chip {
  border-radius: 999px;
  padding: 3px 10px;
  font-size: 10px;
  letter-spacing: 0.04em;
}

.tone--ok {
  background: var(--moss-tint);
  color: var(--moss-deep);
}

.tcard-panel--dark .tone--ok {
  background: rgba(143, 166, 90, 0.22);
  color: #cfe0a8;
}

.tone--warn {
  background: rgba(150, 104, 43, 0.16);
  color: var(--amber);
}

.tcard-panel--dark .tone--warn {
  background: rgba(208, 164, 92, 0.2);
  color: #e4c58c;
}

.tone--mute {
  background: rgba(127, 127, 117, 0.16);
  color: var(--ink-2);
}

.tcard-ledger {
  list-style: none;
  margin: 0;
  padding: 0;
}

.tcard-ledger li {
  display: flex;
  gap: 12px;
  padding: 6px 0;
  border-top: 1px solid rgba(127, 127, 117, 0.18);
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
}

.led-time {
  opacity: 0.55;
}

.led-op {
  flex: 1;
}

.led-verdict--allow {
  color: var(--moss-deep);
}

.led-verdict--deny {
  color: var(--amber);
}

.tcard-panel--dark .led-verdict--allow {
  color: #cfe0a8;
}

.tcard-caption {
  margin: 12px 0 0;
  font-size: 11.5px;
  opacity: 0.62;
}

@media (max-width: 960px) {
  .triptych-head {
    grid-template-columns: 1fr;
    gap: 20px;
  }

  .triptych-lede {
    justify-self: start;
  }

  .triptych-pillars {
    grid-template-columns: 1fr;
    gap: 28px;
    margin-top: 48px;
  }

  .triptych-cards {
    grid-template-columns: 1fr;
    margin-top: 36px;
  }

  .tcard {
    min-height: 340px;
  }
}
</style>
