<script setup lang="ts">
import { ref, computed } from 'vue'
import { useData } from 'vitepress'

const { page, frontmatter } = useData()
const copied = ref(false)

const isDocPage = computed(() => frontmatter.value.layout === undefined)

const rawModules = import.meta.glob<string>('../../**/*.md', {
  query: '?raw',
  import: 'default',
  eager: false,
})

async function copyMarkdown() {
  const relativePath = page.value.relativePath
  const loader = rawModules[`../../${relativePath}`]

  let content: string

  if (loader) {
    content = await loader()
  } else {
    const response = await fetch(`/${relativePath}`)
    content = await response.text()
  }

  // Strip frontmatter from the copied content
  const stripped = content.replace(/^---\n[\s\S]*?\n---\n*/, '')

  await navigator.clipboard.writeText(stripped.trim())
  copied.value = true
  setTimeout(() => { copied.value = false }, 2000)
}
</script>

<template>
  <button
    v-if="isDocPage"
    class="copy-md-btn"
    :class="{ copied }"
    @click="copyMarkdown"
    :title="copied ? 'Copied!' : 'Copy as Markdown'"
  >
    <svg v-if="!copied" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
    </svg>
    <svg v-else xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
    <span>{{ copied ? 'Copied!' : 'Copy as Markdown' }}</span>
  </button>
</template>

<style scoped>
.copy-md-btn {
  position: fixed;
  bottom: 24px;
  right: 24px;
  z-index: 999;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg-elv);
  color: var(--vp-c-text-2);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
  backdrop-filter: blur(8px);
}

.copy-md-btn:hover {
  color: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-1);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  transform: translateY(-1px);
}

.copy-md-btn.copied {
  color: #10b981;
  border-color: #10b981;
}
</style>
