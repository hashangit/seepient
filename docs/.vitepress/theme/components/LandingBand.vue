<script setup lang="ts">
import { withBase } from 'vitepress'

const branch = `${withBase('/textures/branch.jpg')}`
</script>

<template>
  <section class="band" aria-label="Exact commit protection">
    <div class="band-bg" :style="{ backgroundImage: `url(${branch})` }" aria-hidden="true"></div>

    <div class="lp-section band-inner">
      <div class="band-copy" v-reveal>
        <span class="lp-kicker">Exact commits</span>
        <h2 class="lp-h2 band-title">
          <span class="soft">Writes land exactly —</span><br />
          or not at all.
        </h2>
        <p class="lp-lede band-lede">
          Model file edits are applied by a native commit helper that re-reads
          the file and compares it against the pre-image the model saw. If
          anything moved underneath — a symlink, a race, a stale buffer — the
          write is refused.
        </p>
        <a class="band-link" href="/seepient/security/exact-commit">How exact commit works →</a>
      </div>

      <aside class="band-panel" v-reveal aria-label="Commit verification steps">
        <p class="panel-kicker">Commit verification</p>
        <ul class="panel-rows">
          <li>
            <span class="pr-label">pre-image sha</span>
            <span class="pr-value pr-value--ok">✓ verified</span>
          </li>
          <li>
            <span class="pr-label">symlink escape</span>
            <span class="pr-value pr-value--warn">✗ rejected · O_NOFOLLOW</span>
          </li>
          <li>
            <span class="pr-label">result</span>
            <span class="pr-value pr-value--ink">committed 4f2c9a1</span>
          </li>
        </ul>
        <p class="panel-meta">Patch applied only when disk matches what the model saw.</p>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.band {
  position: relative;
  margin-top: 60px;
  overflow: hidden;
}

.band-bg {
  position: absolute;
  inset: 0;
  background-size: cover;
  background-position: center right 20%;
  -webkit-mask-image: linear-gradient(90deg, transparent 0%, rgba(0, 0, 0, 0.45) 42%, #000 72%);
  mask-image: linear-gradient(90deg, transparent 0%, rgba(0, 0, 0, 0.45) 42%, #000 72%);
}

.band-inner {
  position: relative;
  display: grid;
  grid-template-columns: 1.1fr 0.9fr;
  gap: 64px;
  align-items: center;
  padding-top: 96px;
  padding-bottom: 96px;
}

.band-title {
  margin-top: 24px;
}

.band-lede {
  margin-top: 22px;
  max-width: 460px;
}

.band-link {
  display: inline-block;
  margin-top: 26px;
  font-size: 13.5px;
  font-weight: 560;
  color: var(--moss-deep);
  text-decoration: none;
}

.band-link:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}

.band-panel {
  justify-self: end;
  width: min(360px, 100%);
  background: var(--glass-bg);
  backdrop-filter: var(--glass-filter);
  -webkit-backdrop-filter: var(--glass-filter);
  border: 1px solid var(--glass-border);
  border-radius: 16px;
  padding: 20px 22px;
  box-shadow: var(--glass-shadow);
}

.panel-kicker {
  margin: 0;
  font-family: var(--vp-font-family-mono);
  font-size: 10px;
  font-weight: 550;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--ink-3);
}

.panel-rows {
  list-style: none;
  margin: 12px 0 0;
  padding: 0;
}

.panel-rows li {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 14px;
  padding: 9px 0;
  border-top: 1px solid var(--line);
  font-family: var(--vp-font-family-mono);
  font-size: 11.5px;
}

.panel-rows li:first-child {
  border-top: none;
}

.pr-label {
  color: var(--ink-2);
}

.pr-value--ok {
  color: var(--moss-deep);
}

.pr-value--warn {
  color: var(--amber);
}

.pr-value--ink {
  color: var(--ink);
  font-weight: 600;
}

.panel-meta {
  margin: 12px 0 0;
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--ink-3);
}

@media (max-width: 960px) {
  .band-inner {
    grid-template-columns: 1fr;
    gap: 36px;
  }

  .band-panel {
    justify-self: start;
  }

  .band-bg {
    opacity: 0.55;
  }
}
</style>
