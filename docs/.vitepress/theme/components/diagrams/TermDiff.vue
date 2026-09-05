<script setup>
defineProps({
  title: { type: String, required: true },
  lines: { type: Array, required: true },
  meta: { type: Array, default: () => [] },
})
</script>

<template>
  <div class="tdiffcard">
    <div class="tdiffcard-screen">
      <p class="tdiffcard-title">{{ title }}</p>
      <p
        v-for="(line, i) in lines"
        :key="i"
        class="tline"
        :class="{
          'tline-add': line.startsWith('+'),
          'tline-del': line.startsWith('-'),
        }"
      >{{ line }}</p>
    </div>
    <div v-if="meta.length" class="tdiffcard-meta">
      <p v-for="m in meta" :key="m" class="tmeta">{{ m }}</p>
    </div>
  </div>
</template>

<style scoped>
.tdiffcard {
  margin: 1.75rem 0;
  background: #1a1a1a;
  border: 1px solid rgba(243, 243, 240, 0.09);
  border-radius: 14px;
  overflow: hidden;
  font-family: var(--vp-font-family-mono);
}

.tdiffcard-screen {
  padding: 14px 20px;
  overflow-x: auto;
}

.tdiffcard-title {
  margin: 0 0 8px;
  font-size: 11px;
  letter-spacing: 0.08em;
  color: rgba(226, 226, 220, 0.5);
  white-space: nowrap;
}

.tline {
  margin: 0;
  font-size: 12px;
  line-height: 1.8;
  color: rgba(226, 226, 220, 0.72);
  white-space: pre;
}

.tline-add {
  color: #9cc37a;
}

.tline-del {
  color: #e08b82;
}

.tdiffcard-meta {
  border-top: 1px solid rgba(243, 243, 240, 0.08);
  padding: 10px 20px;
}

.tmeta {
  margin: 0;
  font-size: 11px;
  line-height: 1.8;
  color: rgba(226, 226, 220, 0.45);
}
</style>
