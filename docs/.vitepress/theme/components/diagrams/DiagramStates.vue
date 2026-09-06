<script setup>
import { computed } from 'vue'

const props = defineProps({
  states: { type: Array, required: true },
  transitions: { type: Array, default: () => [] },
  loop: { type: String, default: '' },
})

const normalized = computed(() =>
  props.states.map((s) => (typeof s === 'string' ? { name: s } : s)),
)
</script>

<template>
  <div class="dstates">
    <div class="dstates-rail">
      <template v-for="(s, i) in normalized" :key="s.name">
        <div class="dstate">
          <span class="dstate-name">{{ s.name }}</span>
        </div>
        <div v-if="i < normalized.length - 1" class="dstate-link" aria-hidden="true">
          <span class="dstate-arrow"></span>
          <span v-if="transitions[i]" class="dstate-note">{{ transitions[i] }}</span>
        </div>
      </template>
    </div>
    <p v-if="loop" class="dstate-loop">{{ loop }}</p>
  </div>
</template>

<style scoped>
.dstates {
  margin: 1.75rem 0;
    border: 1px solid #1e293b;
  border-radius: 14px;
  background:
    linear-gradient(rgba(30, 41, 59, 0.33) 1px, transparent 1px),
    linear-gradient(90deg, rgba(30, 41, 59, 0.33) 1px, transparent 1px),
    linear-gradient(160deg, #0d1526, #070c18 65%);
  background-size: 28px 28px, 28px 28px, cover;
  box-shadow: 0 32px 70px -38px rgba(7, 12, 24, 0.7);
  padding: 26px 26px 20px;
}

.dstates-rail {
  display: flex;
  align-items: flex-start;
  gap: 14px;
}

.dstate {
  background: rgba(255, 255, 255, 0.5);
  border: 1px solid var(--glass-border);
  border-radius: 10px;
  padding: 11px 18px;
  flex-shrink: 0;
}

.dstate-name {
  font-family: var(--vp-font-family-mono);
  font-size: 12.5px;
  font-weight: 550;
  color: #e2e8f0;
  white-space: nowrap;
}

.dstate-link {
  flex: 1;
  min-width: 56px;
  padding-top: 14px;
  position: relative;
}

.dstate-arrow {
  display: block;
  height: 1px;
  background: rgba(148, 163, 184, 0.5);
  position: relative;
  margin-top: 7px;
}

.dstate-arrow::before {
  content: '';
  position: absolute;
  right: -1px;
  top: -3px;
  border-top: 3.5px solid transparent;
  border-bottom: 3.5px solid transparent;
  border-left: 5px solid #34d399;
}

.dstate-note {
  display: block;
  margin-top: 9px;
  text-align: center;
  font-family: var(--vp-font-family-mono);
  font-size: 10.5px;
  color: #94a3b8;
  white-space: nowrap;
}

.dstate-loop {
  margin: 18px 0 0;
  padding-top: 14px;
  border-top: 1px dashed rgba(148, 163, 184, 0.3);
  font-family: var(--vp-font-family-mono);
  font-size: 10.5px;
  color: #94a3b8;
}

@media (max-width: 960px) {
  .dstates-rail {
    flex-direction: column;
    align-items: stretch;
  }

  .dstate-link {
    min-height: 34px;
    padding: 0 0 0 20px;
  }

  .dstate-note {
    text-align: left;
  }
}
</style>
