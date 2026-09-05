<script setup>
import { computed } from 'vue'

const props = defineProps({
  steps: { type: Array, required: true },
  numbered: { type: Boolean, default: false },
})

const hasNotes = computed(() => props.steps.some((s) => s.note))
</script>

<template>
  <div class="dflow" :class="{ 'has-notes': hasNotes }">
    <template v-for="(s, i) in steps" :key="i">
      <div class="dstep-main">
        <div class="dstep-card">
          <span v-if="numbered" class="dstep-num">{{ String(i + 1).padStart(2, '0') }}</span>
          <div class="dstep-body">
            <p class="dstep-title">{{ s.title }}</p>
            <p v-if="s.tagline" class="dstep-tagline">{{ s.tagline }}</p>
            <p v-if="s.desc" class="dstep-desc">{{ s.desc }}</p>
            <div v-if="s.chips" class="dstep-chips">
              <span v-for="c in s.chips" :key="c" class="dstep-chip">{{ c }}</span>
            </div>
          </div>
        </div>
        <p v-if="s.note" class="dstep-note">{{ s.note }}</p>
      </div>
      <div v-if="i < steps.length - 1" class="dstep-connector" aria-hidden="true">
        <span class="dstep-line"></span>
        <span class="dstep-arrow"></span>
        <span v-if="s.edge" class="dstep-edge">{{ s.edge }}</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.dflow {
  margin: 1.75rem 0;
}

.dstep-main {
  display: grid;
  gap: 12px 24px;
}

.dflow.has-notes .dstep-main {
  grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr);
  align-items: center;
}

.dstep-card {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  background: rgba(255, 255, 255, 0.6);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 14px 18px;
  transition: border-color 0.25s ease;
}

.dstep-card:hover {
  border-color: rgba(95, 122, 61, 0.5);
}

.dstep-num {
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
  font-weight: 550;
  color: var(--moss-deep);
  border: 1px solid rgba(95, 122, 61, 0.4);
  border-radius: 999px;
  padding: 3px 9px;
  margin-top: 1px;
  flex-shrink: 0;
}

.dstep-title {
  margin: 0;
  font-family: var(--vp-font-family-heading);
  font-size: 15.5px;
  font-weight: 620;
  letter-spacing: -0.01em;
  color: var(--ink);
}

.dstep-tagline {
  margin: 3px 0 0;
  font-size: 12.5px;
  color: var(--ink-3);
}

.dstep-desc {
  margin: 4px 0 0;
  font-size: 13px;
  line-height: 1.55;
  color: var(--ink-2);
}

.dstep-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  margin-top: 9px;
}

.dstep-chip {
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
  color: var(--ink-2);
  background: var(--paper-2);
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 3px 10px;
}

.dstep-note {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--ink-2);
}

/* Connector between steps: animated dashed rail with arrowhead */
.dstep-connector {
  position: relative;
  height: 40px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding-left: 34px;
}

.dflow.has-notes .dstep-connector {
  width: 50%;
  padding-right: 12px;
}

.dstep-line {
  position: absolute;
  left: 33px;
  top: 4px;
  bottom: 6px;
  width: 2px;
  background-image: linear-gradient(rgba(95, 122, 61, 0.55) 45%, transparent 0);
  background-size: 2px 9px;
  background-repeat: repeat-y;
}

@media (prefers-reduced-motion: no-preference) {
  .dstep-line {
    animation: dflow-dash 0.8s linear infinite;
  }

  @keyframes dflow-dash {
    to {
      background-position: 0 9px;
    }
  }
}

.dstep-arrow {
  position: absolute;
  left: 30px;
  bottom: -1px;
  width: 0;
  height: 0;
  border-left: 5px solid transparent;
  border-right: 5px solid transparent;
  border-top: 6px solid rgba(95, 122, 61, 0.6);
}

.dstep-edge {
  font-family: var(--vp-font-family-mono);
  font-size: 10.5px;
  letter-spacing: 0.05em;
  color: var(--ink-3);
  padding: 3px 10px;
  background: var(--paper-2);
  border-radius: 999px;
}

@media (max-width: 960px) {
  .dflow.has-notes .dstep-main {
    grid-template-columns: 1fr;
  }
}
</style>
