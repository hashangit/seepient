<script setup>
defineProps({
  title: { type: String, required: true },
  subtitle: { type: String, default: '' },
  endpoints: { type: Array, required: true },
  modules: { type: Array, default: () => [] },
})
</script>

<template>
  <div class="dmap">
    <div v-for="(e, i) in endpoints" :key="i" class="dmap-row">
      <div class="dmap-edge">
        <span class="dmap-edge-label">{{ e.label }}</span>
        <span v-if="e.sub" class="dmap-edge-sub">{{ e.sub }}</span>
      </div>
      <div class="dmap-edge-line" aria-hidden="true"></div>
      <div class="dmap-paths">
        <code v-for="p in e.paths" :key="p" class="dmap-path">{{ p }}</code>
      </div>
    </div>

    <div class="dmap-panel">
      <p class="dmap-title">{{ title }}</p>
      <p v-if="subtitle" class="dmap-subtitle">{{ subtitle }}</p>
      <div class="dmap-modules">
        <div v-for="m in modules" :key="m.name" class="dmap-module">
          <p class="dmap-module-name">{{ m.name }}</p>
          <p class="dmap-module-desc">{{ m.desc }}</p>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dmap {
  margin: 1.75rem 0;
    border: 1px solid #1e293b;
  border-radius: 14px;
  background:
    linear-gradient(rgba(30, 41, 59, 0.33) 1px, transparent 1px),
    linear-gradient(90deg, rgba(30, 41, 59, 0.33) 1px, transparent 1px),
    linear-gradient(160deg, #0d1526, #070c18 65%);
  background-size: 28px 28px, 28px 28px, cover;
  box-shadow: 0 32px 70px -38px rgba(7, 12, 24, 0.7);
  padding: 22px 24px;
}

.dmap-row {
  display: grid;
  grid-template-columns: 150px 28px 1fr;
  align-items: center;
  gap: 0 10px;
  padding: 7px 0;
}

.dmap-edge {
  text-align: right;
}

.dmap-edge-label {
  display: block;
  font-size: 13.5px;
  font-weight: 600;
  color: #e2e8f0;
}

.dmap-edge-sub {
  display: block;
  font-family: var(--vp-font-family-mono);
  font-size: 10.5px;
  color: var(--ink-3);
}

.dmap-edge-line {
  height: 1px;
  background: rgba(148, 163, 184, 0.5);
  position: relative;
}

.dmap-edge-line::after {
  content: '';
  position: absolute;
  right: -1px;
  top: -3px;
  border-top: 3.5px solid transparent;
  border-bottom: 3.5px solid transparent;
  border-left: 5px solid rgba(148, 163, 184, 0.7);
}

.dmap-paths {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.dmap-path {
  font-family: var(--vp-font-family-mono);
  font-size: 11.5px;
  color: var(--ink);
  background: rgba(255, 255, 255, 0.5);
  border: 1px solid var(--glass-border);
  border-radius: 6px;
  padding: 4px 10px;
}

.dmap-panel {
  margin-top: 16px;
  border-top: 1px solid rgba(148, 163, 184, 0.18);
  padding-top: 18px;
}

.dmap-title {
  margin: 0;
  font-family: var(--vp-font-family-mono);
  font-size: 10.5px;
  font-weight: 550;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: #34d399;
}

.dmap-subtitle {
  margin: 6px 0 0;
  font-size: 12px;
  color: #64748b;
}

.dmap-modules {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
  margin-top: 14px;
}

.dmap-module {
  background: rgba(255, 255, 255, 0.45);
  border: 1px solid var(--glass-border);
  border-radius: 10px;
  padding: 12px 14px;
}

.dmap-module-name {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: #e2e8f0;
}

.dmap-module-desc {
  margin: 3px 0 0;
  font-family: var(--vp-font-family-mono);
  font-size: 10.5px;
  line-height: 1.5;
  color: #94a3b8;
}
</style>
