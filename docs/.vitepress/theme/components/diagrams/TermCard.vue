<script setup>
defineProps({
  lines: { type: Array, required: true },
})
</script>

<template>
  <div class="tcard">
    <p
      v-for="(line, i) in lines"
      :key="i"
      class="tcard-line"
      :class="{
        'tcard-ok': line.startsWith('✔') || line.startsWith('✓'),
        'tcard-live': line.startsWith('⠋') || line.startsWith('⠿') || line.startsWith('▸'),
      }"
    >{{ line }}</p>
  </div>
</template>

<style scoped>
.tcard {
  margin: 1.75rem 0;
  background: #1a1a1a;
  border: 1px solid rgba(243, 243, 240, 0.09);
  border-radius: 14px;
  padding: 14px 20px;
  font-family: var(--vp-font-family-mono);
  overflow-x: auto;
}

.tcard-line {
  margin: 0;
  font-size: 12px;
  line-height: 1.85;
  color: rgba(226, 226, 220, 0.75);
  white-space: pre;
}

.tcard-line.tcard-ok {
  color: #9cc37a;
}

.tcard-line.tcard-live {
  color: #a3b368;
}
</style>
