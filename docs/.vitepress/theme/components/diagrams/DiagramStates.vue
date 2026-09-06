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
  border: 1px solid var(--line);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.55);
  padding: 26px 26px 20px;
}

.dstates-rail {
  display: flex;
  align-items: flex-start;
  gap: 14px;
}

.dstate {
  background: rgba(255, 255, 255, 0.75);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 11px 18px;
  flex-shrink: 0;
}

.dstate-name {
  font-family: var(--vp-font-family-mono);
  font-size: 12.5px;
  font-weight: 550;
  color: var(--ink);
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
  background: rgba(19, 19, 17, 0.3);
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
  border-left: 5px solid rgba(95, 122, 61, 0.7);
}

.dstate-note {
  display: block;
  margin-top: 9px;
  text-align: center;
  font-family: var(--vp-font-family-mono);
  font-size: 10.5px;
  color: var(--ink-3);
  white-space: nowrap;
}

.dstate-loop {
  margin: 18px 0 0;
  padding-top: 14px;
  border-top: 1px dashed var(--line);
  font-family: var(--vp-font-family-mono);
  font-size: 10.5px;
  color: var(--ink-3);
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
