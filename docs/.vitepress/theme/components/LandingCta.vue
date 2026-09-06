<script setup lang="ts">
import { withBase } from 'vitepress'

const mossPill = `${withBase('/textures/pill-moss.jpg')}`
const shorePill = `${withBase('/textures/pill-shore.jpg')}`

const columns = [
  {
    title: 'Getting started',
    links: [
      { text: 'Introduction', href: '/guides/introduction' },
      { text: 'Quick start', href: '/guides/quick-start' },
      { text: 'Installation', href: '/guides/installation' },
      { text: 'Configuration', href: '/guides/configuration' },
    ],
  },
  {
    title: 'Surfaces',
    links: [
      { text: 'Terminal UI', href: '/tui/overview' },
      { text: 'CLI', href: '/cli/overview' },
      { text: 'TypeScript SDK', href: '/sdk/overview' },
      { text: 'Server', href: '/server/overview' },
    ],
  },
  {
    title: 'Security',
    links: [
      { text: 'Permissions & consent', href: '/security/permissions' },
      { text: 'Sandboxing', href: '/security/sandboxing' },
      { text: 'Exact commits', href: '/security/exact-commit' },
      { text: 'Audit trail', href: '/security/audit' },
    ],
  },
  {
    title: 'Cookbook',
    links: [
      { text: 'GitHub Action reviewer', href: '/cookbook/github-action' },
      { text: 'React chat UI', href: '/cookbook/react-chat' },
      { text: 'Local LLMs with Ollama', href: '/cookbook/local-llm' },
      { text: 'Production checklist', href: '/cookbook/production-checklist' },
    ],
  },
]
</script>

<template>
  <section class="cta">
    <div class="cta-inner">
      <span class="lp-kicker" v-reveal>Ship agents you can trust</span>
      <h2 class="cta-title" v-reveal>
        Take control
        <span class="cta-pill" :style="{ backgroundImage: `url(${mossPill})` }" aria-hidden="true"></span>
        of your agents.<br />
        <span class="soft">Operate at a new level</span>
        <span class="cta-pill" :style="{ backgroundImage: `url(${shorePill})` }" aria-hidden="true"></span>
      </h2>
      <div class="cta-actions" v-reveal>
        <a class="lp-btn lp-btn--ink" href="/guides/quick-start">Quick start</a>
        <a class="lp-btn lp-btn--ghost" href="/cookbook/overview">Browse the cookbook</a>
      </div>
    </div>

    <footer class="footer">
      <div class="footer-inner">
        <div class="footer-brand">
          <p class="footer-logo">Seepient</p>
          <p class="footer-tag">
            An autonomous AI agent species.<br />
            Terminal-first, policy-governed, embedder-owned.
          </p>
        </div>
        <nav v-for="col in columns" :key="col.title" class="footer-col" :aria-label="col.title">
          <p class="footer-col-title">{{ col.title }}</p>
          <ul class="footer-links">
            <li v-for="link in col.links" :key="link.href">
              <a :href="link.href">{{ link.text }}</a>
            </li>
          </ul>
        </nav>
      </div>
      <div class="footer-base">
        <span>© 2024–present Seepient contributors · BSL 1.1</span>
        <span>Built with VitePress</span>
      </div>
    </footer>
  </section>
</template>

<style scoped>
.cta {
  border-top: 1px solid var(--line);
}

.cta-inner {
  max-width: 1040px;
  margin: 0 auto;
  padding: 140px 32px 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
}

.cta-title {
  font-family: var(--vp-font-family-heading);
  font-size: clamp(2.5rem, 5.6vw, 4.4rem);
  font-weight: 680;
  letter-spacing: -0.04em;
  line-height: 1.04;
  color: var(--ink);
  margin: 36px 0 0;
  text-wrap: balance;
}

.cta-title .soft {
  color: var(--ink-3);
}

.cta-pill {
  display: inline-block;
  width: 1.7em;
  height: 0.62em;
  border-radius: 999px;
  background-size: cover;
  background-position: center;
  vertical-align: baseline;
  transform: translateY(0.06em);
  margin: 0 0.08em;
  box-shadow: inset 0 0 0 1px rgba(19, 19, 17, 0.12);
}

.cta-actions {
  display: flex;
  gap: 12px;
  margin-top: 44px;
  flex-wrap: wrap;
  justify-content: center;
}

/* Footer */
.footer {
  max-width: 1200px;
  margin: 130px auto 0;
  padding: 56px 32px 40px;
  border-top: 1px solid var(--line);
}

.footer-inner {
  display: grid;
  grid-template-columns: 1.4fr repeat(4, 1fr);
  gap: 40px;
}

.footer-logo {
  font-family: var(--vp-font-family-heading);
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--ink);
  margin: 0;
}

.footer-tag {
  margin: 12px 0 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--ink-2);
}

.footer-col-title {
  font-family: var(--vp-font-family-mono);
  font-size: 10px;
  font-weight: 550;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--ink-3);
  margin: 4px 0 14px;
}

.footer-links {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.footer-links a {
  font-size: 13px;
  color: var(--ink-2);
  text-decoration: none;
}

.footer-links a:hover {
  color: var(--ink);
}

.footer-base {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin-top: 64px;
  padding-top: 22px;
  border-top: 1px solid var(--line);
  font-family: var(--vp-font-family-mono);
  font-size: 10.5px;
  letter-spacing: 0.06em;
  color: var(--ink-3);
}

@media (max-width: 960px) {
  .cta-inner {
    padding-top: 100px;
  }

  .footer-inner {
    grid-template-columns: 1fr 1fr;
    gap: 32px;
  }

  .footer-brand {
    grid-column: 1 / -1;
  }
}
</style>
