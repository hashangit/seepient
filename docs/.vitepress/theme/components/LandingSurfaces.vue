<script setup lang="ts">
const surfaces = [
  {
    idx: '01',
    name: 'Terminal UI',
    cmd: 'seepient',
    body: 'Full-screen Ink interface with streaming output, live widgets, inline diff review and slash commands.',
    link: '/tui/overview',
  },
  {
    idx: '02',
    name: 'CLI',
    cmd: 'git diff | seepient "review for regressions"',
    body: 'One-shot prompts, Unix pipes and non-interactive -y runs for scripts, cron jobs and CI.',
    link: '/cli/overview',
  },
  {
    idx: '03',
    name: 'TypeScript SDK',
    cmd: "const agent = createSeepient({ stores })",
    body: 'generateText and streamText with injectable storage, custom tools, hooks and purpose routing.',
    link: '/sdk/overview',
  },
  {
    idx: '04',
    name: 'Server',
    cmd: 'seepient-server --port 7337',
    body: 'REST and WebSocket surface with scoped API keys, session persistence and an mTLS worker scheduler.',
    link: '/server/overview',
  },
]
</script>

<template>
  <section class="lp-section surfaces">
    <header class="surfaces-head" v-reveal>
      <span class="lp-kicker">Surfaces</span>
      <h2 class="lp-h2">
        <span class="soft">Four ways in.</span> One runtime.
      </h2>
      <p class="lp-lede surfaces-lede">
        Pick the surface that fits the job. Each one resolves the same config,
        asks the same policy engine, and writes the same audit trail.
      </p>
    </header>

    <div class="surfaces-grid">
      <a
        v-for="s in surfaces"
        :key="s.idx"
        class="scard"
        :href="s.link"
        v-reveal
      >
        <span class="lp-idx">{{ s.idx }}</span>
        <h3 class="scard-name">{{ s.name }}</h3>
        <code class="scard-cmd">{{ s.cmd }}</code>
        <p class="scard-body">{{ s.body }}</p>
        <span class="scard-link">Explore <span aria-hidden="true">→</span></span>
      </a>
    </div>
  </section>
</template>

<style scoped>
.surfaces-head {
  max-width: 640px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 22px;
}

.surfaces-lede {
  margin-top: 2px;
}

.surfaces-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
  margin-top: 56px;
}

.scard {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0;
  background: var(--glass-bg);
  backdrop-filter: var(--glass-filter);
  -webkit-backdrop-filter: var(--glass-filter);
  border: 1px solid var(--glass-border);
  border-radius: 16px;
  padding: 22px;
  box-shadow: var(--glass-shadow-sm);
  text-decoration: none !important;
  transition: transform 0.25s ease, box-shadow 0.25s ease, border-color 0.25s ease;
}

.scard:hover {
  transform: translateY(-3px);
  border-color: rgba(255, 255, 255, 0.9);
  box-shadow: var(--glass-shadow);
}

.scard-name {
  font-family: var(--vp-font-family-heading);
  font-size: 1.05rem;
  font-weight: 640;
  letter-spacing: -0.015em;
  color: var(--ink);
  margin: 10px 0 0;
}

.scard-cmd {
  display: block;
  width: 100%;
  margin-top: 14px;
  background: var(--code-bg);
  color: var(--code-ink);
  font-family: var(--vp-font-family-mono);
  font-size: 10.8px;
  line-height: 1.5;
  border-radius: 8px;
  padding: 10px 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.scard-body {
  font-size: 13px;
  line-height: 1.62;
  color: var(--ink-2);
  margin: 12px 0 0;
}

.scard-link {
  margin-top: auto;
  padding-top: 18px;
  font-size: 12.5px;
  font-weight: 560;
  color: var(--moss-deep);
}

.scard-link span {
  display: inline-block;
  transition: transform 0.2s ease;
}

.scard:hover .scard-link span {
  transform: translateX(3px);
}

@media (max-width: 1100px) {
  .surfaces-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 640px) {
  .surfaces-grid {
    grid-template-columns: 1fr;
  }
}
</style>
