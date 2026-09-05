<script setup>
defineProps({
  title: { type: String, required: true },
  items: { type: Array, required: true },
  selected: { type: Number, default: 0 },
})
</script>

<template>
  <div class="tmenu">
    <p class="tmenu-title">{{ title }}</p>
    <ol class="tmenu-items">
      <li
        v-for="(item, i) in items"
        :key="item"
        :class="{ 'is-selected': i === selected }"
      >
        <span class="tmenu-caret" aria-hidden="true">{{ i === selected ? '❯' : '' }}</span>
        <span class="tmenu-num">{{ i + 1 }}.</span>
        {{ item }}
      </li>
    </ol>
  </div>
</template>

<style scoped>
.tmenu {
  margin: 1.75rem 0;
  background: #1a1a1a;
  border: 1px solid rgba(243, 243, 240, 0.09);
  border-radius: 14px;
  padding: 16px 20px;
  font-family: var(--vp-font-family-mono);
  overflow-x: auto;
}

.tmenu-title {
  margin: 0 0 12px;
  font-size: 11px;
  letter-spacing: 0.08em;
  color: rgba(226, 226, 220, 0.5);
  white-space: nowrap;
}

.tmenu-items {
  list-style: none;
  margin: 0;
  padding: 0;
}

.tmenu-items li {
  display: flex;
  gap: 8px;
  font-size: 12.5px;
  line-height: 2;
  color: rgba(226, 226, 220, 0.6);
  white-space: nowrap;
}

.tmenu-items li.is-selected {
  color: #e2e2dc;
}

.tmenu-caret {
  color: #a3b368;
  width: 12px;
  flex-shrink: 0;
}

.tmenu-num {
  flex-shrink: 0;
}
</style>
