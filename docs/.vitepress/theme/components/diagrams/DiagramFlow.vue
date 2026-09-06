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
/* archify instrument panel: slate canvas, faint grid, mono steps,
   dashed flow with triangle heads. */
.dflow {
  margin: 1.75rem 0;
  background:
    linear-gradient(rgba(30, 41, 59, 0.33) 1px, transparent 1px),
    linear-gradient(90deg, rgba(30, 41, 59, 0.33) 1px, transparent 1px),
    linear-gradient(160deg, #0d1526, #070c18 65%);
  background-size: 28px 28px, 28px 28px, cover;
  border: 1px solid #1e293b;
  border-radius: 14px;
  padding: 24px 24px 18px;
  box-shadow: 0 32px 70px -38px rgba(7, 12, 24, 0.7);
}

.dstep-main {
  display: grid;
  gap: 10px 24px;
}

.dflow.has-notes .dstep-main {
  grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr);
  align-items: center;
}

.dstep-card {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  background: rgba(15, 23, 42, 0.6);
  border: 1px solid rgba(52, 211, 153, 0.32);
  border-radius: 9px;
  padding: 13px 17px;
  transition: border-color 0.25s ease, box-shadow 0.25s ease;
}

.dstep-card:hover {
  border-color: #34d399;
  box-shadow: 0 0 28px -10px rgba(52, 211, 153, 0.45);
}

.dstep-num {
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
  font-weight: 550;
  color: #34d399;
  border: 1px solid rgba(52, 211, 153, 0.45);
  border-radius: 999px;
  padding: 3px 9px;
  margin-top: 1px;
  flex-shrink: 0;
}

.dstep-title {
  margin: 0;
  font-family: var(--vp-font-family-mono);
  font-size: 12.5px;
  font-weight: 550;
  letter-spacing: 0.04em;
  color: #e2e8f0;
}

.dstep-tagline {
  margin: 3px 0 0;
  font-size: 12.5px;
  color: #94a3b8;
}

.dstep-desc {
  margin: 4px 0 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: #94a3b8;
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
  color: #cbd5e1;
  background: rgba(2, 6, 23, 0.5);
  border: 1px solid rgba(148, 163, 184, 0.28);
  border-radius: 7px;
  padding: 4px 11px;
}

.dstep-note {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: #94a3b8;
}

/* Connector: dashed rail + triangle head + optional edge label */
.dstep-connector {
  position: relative;
  height: 38px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding-left: 40px;
}

.dflow.has-notes .dstep-connector {
  width: 50%;
  padding-right: 12px;
}

.dstep-line {
  position: absolute;
  left: 39px;
  top: 3px;
  bottom: 7px;
  width: 2px;
  background-image: linear-gradient(#64748b 45%, transparent 0);
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
  left: 36px;
  bottom: -1px;
  width: 0;
  height: 0;
  border-left: 5px solid transparent;
  border-right: 5px solid transparent;
  border-top: 6px solid #64748b;
}

.dstep-edge {
  font-family: var(--vp-font-family-mono);
  font-size: 10.5px;
  letter-spacing: 0.05em;
  color: #94a3b8;
  border: 1px solid rgba(148, 163, 184, 0.28);
  border-radius: 999px;
  padding: 3px 11px;
  background: rgba(2, 6, 23, 0.5);
}

@media (max-width: 960px) {
  .dflow.has-notes .dstep-main {
    grid-template-columns: 1fr;
  }

  .dflow {
    padding: 18px 16px 14px;
  }
}
</style>
