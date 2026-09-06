<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useData, useRoute, withBase } from 'vitepress'

const { theme } = useData()
const route = useRoute()

const navItems = computed(() => theme.value.nav || [])

const searchSlot = ref(null)

// Adopt VitePress's real search control so the button, hot-key and modal
// all keep working natively; it just lives inside the floating bar now.
onMounted(() => {
  let tries = 0
  const adopt = () => {
    const node = document.querySelector('.VPNavBar .VPNavBarSearch')
    if (node && searchSlot.value) {
      searchSlot.value.appendChild(node)
    } else if (tries++ < 40) {
      requestAnimationFrame(adopt)
    }
  }
  adopt()
})

function isActive(item) {
  const path = route.data.relativePath
  if (item.activeMatch) return new RegExp(item.activeMatch).test('/' + path)
  if (!item.link) return false
  return ('/' + path).startsWith(item.link)
}

function hasChildren(item) {
  return Array.isArray(item.items) && item.items.length > 0
}

/* Dropdown state: only one open at a time */
const openDropdown = ref('')
const mobileOpen = ref(false)

function toggleDropdown(text) {
  openDropdown.value = openDropdown.value === text ? '' : text
}

function closeAll() {
  openDropdown.value = ''
}

function onDocClick(e) {
  if (!e.target.closest('.fn-item')) closeAll()
  if (!e.target.closest('.fn-shell')) mobileOpen.value = false
}

function onKeydown(e) {
  if (e.key === 'Escape') {
    closeAll()
    mobileOpen.value = false
  }
}

onMounted(() => {
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onKeydown)
})

onUnmounted(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onKeydown)
})

/* Flatten sub-groups (Reference-style nested items) into labelled columns */
function groupsOf(item) {
  if (!hasChildren(item)) return []
  const hasNested = item.items.some((i) => Array.isArray(i.items))
  if (!hasNested) return [{ title: '', items: item.items }]
  return item.items.map((g) => ({ title: g.text, items: g.items || [] }))
}

const github = computed(() => {
  const links = theme.value.socialLinks || []
  return links.find((l) => l.icon === 'github')?.link || 'https://github.com'
})

const path = computed(() => '/' + route.data.relativePath)
</script>

<template>
  <div class="fnav-wrap">
    <nav class="fnav" aria-label="Main navigation">
      <div class="fnav-left">
        <a class="fnav-logo" :href="withBase('/')">Seepient</a>
        <span class="fnav-divider" aria-hidden="true"></span>
        <div ref="searchSlot" class="fnav-search"></div>
      </div>

      <button
        class="fnav-burger"
        type="button"
        :aria-expanded="mobileOpen"
        aria-label="Toggle menu"
        @click.stop="mobileOpen = !mobileOpen"
      >
        <span :class="{ open: mobileOpen }"></span>
      </button>

      <div class="fnav-right">
        <div v-for="item in navItems" :key="item.text" class="fn-item">
          <a
            v-if="!hasChildren(item)"
            class="fnav-link"
            :class="{ 'is-active': isActive(item) }"
            :href="withBase(item.link)"
          >{{ item.text }}</a>
          <button
            v-else
            type="button"
            class="fnav-link fnav-drop"
            :class="{ 'is-open': openDropdown === item.text, 'is-active': isActive(item) }"
            :aria-expanded="openDropdown === item.text"
            @click.stop="toggleDropdown(item.text)"
            @mouseenter="openDropdown = item.text"
          >
            {{ item.text }}
            <svg class="fnav-caret" viewBox="0 0 10 6" aria-hidden="true">
              <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
            </svg>
          </button>

          <Transition name="fn-pop">
            <div
              v-if="hasChildren(item) && openDropdown === item.text"
              class="fn-panel"
              :class="{ 'fn-panel--wide': groupsOf(item).length > 1 }"
              @mouseleave="openDropdown === item.text && closeAll()"
            >
              <div v-for="group in groupsOf(item)" :key="group.title || item.text" class="fn-group">
                <p v-if="group.title" class="fn-group-title">{{ group.title }}</p>
                <a
                  v-for="child in group.items"
                  :key="child.link"
                  class="fn-panel-link"
                  :class="{ 'is-active': isActive(child) }"
                  :href="withBase(child.link)"
                  @click="closeAll"
                >{{ child.text }}</a>
              </div>
            </div>
          </Transition>
        </div>

        <a class="fnav-github" :href="github" aria-label="GitHub repository">
          <svg class="fnav-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55v-2.17c-3.2.7-3.87-1.36-3.87-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.23-1.28-5.23-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.1 11.1 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.25 5.67.41.35.78 1.05.78 2.12v3.14c0 .3.21.66.8.55A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
          </svg>
        </a>
      </div>
    </nav>

    <!-- Mobile sheet -->
    <Transition name="fn-sheet">
      <div v-if="mobileOpen" class="fn-sheet">
        <div v-for="item in navItems" :key="item.text" class="fn-sheet-group">
          <p v-if="hasChildren(item)" class="fn-sheet-title">{{ item.text }}</p>
          <template v-for="child in (hasChildren(item) ? groupsOf(item).flatMap((g) => g.items) : [item])" :key="child.link">
            <a class="fn-sheet-link" :class="{ 'is-active': isActive(child) }" :href="withBase(child.link)" @click="mobileOpen = false">
              {{ child.text }}
            </a>
          </template>
        </div>
        <a class="fn-sheet-link fn-sheet-github" :href="github">GitHub ↗</a>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.fnav-wrap {
  position: fixed;
  top: 12px;
  left: 0;
  right: 0;
  z-index: 60;
  display: flex;
  justify-content: center;
  padding: 0 12px;
  pointer-events: none;
}

/* Liquid glass: translucent, lens-like edges, no frosting */
.fnav {
  pointer-events: auto;
  width: min(1180px, 100%);
  height: 56px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 10px 0 22px;
  border-radius: 18px;
  background: linear-gradient(115deg, rgba(255, 255, 255, 0.52), rgba(255, 255, 255, 0.22) 60%, rgba(255, 255, 255, 0.38));
  backdrop-filter: saturate(1.8) blur(2px);
  -webkit-backdrop-filter: saturate(1.8) blur(2px);
  border: 1px solid rgba(255, 255, 255, 0.55);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.85),
    inset 0 -1px 1px rgba(19, 19, 17, 0.06),
    0 1px 2px rgba(19, 19, 17, 0.08),
    0 16px 40px -16px rgba(19, 19, 17, 0.35);
}

.fnav-left,
.fnav-right {
  display: flex;
  align-items: center;
  gap: 4px;
}

.fnav-right {
  margin-left: auto;
}

.fnav-logo {
  font-family: var(--vp-font-family-heading);
  font-size: 17px;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--ink);
  text-decoration: none;
  margin-right: 8px;
}

.fnav-divider {
  width: 1px;
  height: 22px;
  background: rgba(19, 19, 17, 0.16);
  margin-right: 10px;
}

/* Search sub-pill — the adopted VitePress control, restyled */
.fnav-search :deep(.DocSearch-Button) {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 14px;
  border-radius: 999px;
  border: 1px solid rgba(19, 19, 17, 0.14);
  background: rgba(255, 255, 255, 0.4);
  color: rgba(19, 19, 17, 0.55);
  cursor: pointer;
  font-family: var(--vp-font-family-base);
  font-size: 12.5px;
  transition: border-color 0.2s ease, background 0.2s ease;
}

.fnav-search :deep(.DocSearch-Button:hover) {
  border-color: rgba(19, 19, 17, 0.3);
  background: rgba(255, 255, 255, 0.7);
}

.fnav-search :deep(.DocSearch-Button-Container) {
  display: flex;
  align-items: center;
  gap: 8px;
}

.fnav-search :deep(.DocSearch-Button-Placeholder) {
  font-size: 12.5px;
}

.fnav-search :deep(.DocSearch-Search-Icon) {
  width: 15px;
  height: 15px;
  color: rgba(19, 19, 17, 0.55);
}

.fnav-search :deep(.DocSearch-Button-Keys) {
  display: flex;
  gap: 3px;
}

.fnav-search :deep(.DocSearch-Button-Key) {
  font-family: var(--vp-font-family-mono);
  font-size: 10px;
  color: rgba(19, 19, 17, 0.5);
  border: 1px solid rgba(19, 19, 17, 0.16);
  border-radius: 5px;
  padding: 2px 5px;
  background: rgba(255, 255, 255, 0.5);
}

.fnav-icon {
  width: 15px;
  height: 15px;
  flex-shrink: 0;
}

/* Links and dropdowns */
.fn-item {
  position: relative;
}

.fnav-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: none;
  background: transparent;
  cursor: pointer;
  font-family: var(--vp-font-family-base);
  font-size: 13px;
  font-weight: 530;
  color: rgba(19, 19, 17, 0.78);
  text-decoration: none;
  padding: 8px 13px;
  border-radius: 999px;
  transition: color 0.2s ease, background 0.2s ease;
}

.fnav-link:hover,
.fnav-link.is-open {
  color: var(--ink);
  background: rgba(255, 255, 255, 0.55);
}

.fnav-link.is-active {
  color: var(--moss-deep);
}

.fnav-caret {
  width: 9px;
  height: 6px;
  opacity: 0.55;
  transition: transform 0.2s ease;
}

.fnav-drop.is-open .fnav-caret {
  transform: rotate(180deg);
}

/* Dropdown panels */
.fn-panel {
  position: absolute;
  top: calc(100% + 10px);
  left: 0;
  min-width: 230px;
  background: linear-gradient(150deg, rgba(255, 255, 255, 0.88), rgba(255, 255, 255, 0.66));
  backdrop-filter: saturate(1.6) blur(4px);
  -webkit-backdrop-filter: saturate(1.6) blur(4px);
  border: 1px solid rgba(255, 255, 255, 0.7);
  border-radius: 14px;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.9),
    0 20px 48px -20px rgba(19, 19, 17, 0.4);
  padding: 8px;
  z-index: 70;
}

.fn-panel--wide {
  display: grid;
  grid-template-columns: repeat(2, minmax(200px, 1fr));
  gap: 4px 18px;
  min-width: 460px;
}

.fn-group-title {
  margin: 6px 10px 4px;
  font-family: var(--vp-font-family-mono);
  font-size: 9.5px;
  font-weight: 550;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--moss-deep);
}

.fn-panel-link {
  display: block;
  padding: 8px 12px;
  border-radius: 9px;
  font-size: 13px;
  color: rgba(19, 19, 17, 0.8);
  text-decoration: none;
  white-space: nowrap;
}

.fn-panel-link:hover {
  background: rgba(255, 255, 255, 0.75);
  color: var(--ink);
}

.fn-panel-link.is-active {
  color: var(--moss-deep);
  font-weight: 570;
}

.fnav-github {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 999px;
  color: var(--ink);
  transition: background 0.2s ease;
}

.fnav-github:hover {
  background: rgba(255, 255, 255, 0.55);
}

.fnav-github .fnav-icon {
  width: 18px;
  height: 18px;
}

/* Hamburger (mobile only) */
.fnav-burger {
  display: none;
  margin-left: auto;
  width: 38px;
  height: 38px;
  border: 1px solid rgba(19, 19, 17, 0.16);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.4);
  cursor: pointer;
  position: relative;
}

.fnav-burger span,
.fnav-burger span::before,
.fnav-burger span::after {
  content: '';
  position: absolute;
  left: 50%;
  width: 16px;
  height: 1.6px;
  background: var(--ink);
  border-radius: 2px;
  transform: translateX(-50%);
  transition: transform 0.25s ease, opacity 0.25s ease;
}

.fnav-burger span { top: 50%; }
.fnav-burger span::before { top: -5px; }
.fnav-burger span::after { top: 5px; }

.fnav-burger span.open { background: transparent; }
.fnav-burger span.open::before { transform: translateX(-50%) translateY(5px) rotate(45deg); }
.fnav-burger span.open::after { transform: translateX(-50%) translateY(-5px) rotate(-45deg); }

/* Mobile sheet */
.fn-sheet {
  position: absolute;
  top: calc(100% + 10px);
  left: 12px;
  right: 12px;
  max-height: calc(100vh - 110px);
  overflow-y: auto;
  border-radius: 18px;
  background: linear-gradient(160deg, rgba(255, 255, 255, 0.92), rgba(255, 255, 255, 0.78));
  backdrop-filter: saturate(1.6) blur(4px);
  -webkit-backdrop-filter: saturate(1.6) blur(4px);
  border: 1px solid rgba(255, 255, 255, 0.7);
  box-shadow: 0 24px 56px -20px rgba(19, 19, 17, 0.4);
  padding: 18px 20px;
  pointer-events: auto;
}

.fn-sheet-title {
  margin: 14px 0 6px;
  font-family: var(--vp-font-family-mono);
  font-size: 9.5px;
  font-weight: 550;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--moss-deep);
}

.fn-sheet-group + .fn-sheet-group {
  margin-top: 4px;
}

.fn-sheet-link {
  display: block;
  padding: 8px 2px;
  font-size: 14px;
  color: rgba(19, 19, 17, 0.82);
  text-decoration: none;
  border-bottom: 1px solid rgba(19, 19, 17, 0.06);
}

.fn-sheet-link.is-active {
  color: var(--moss-deep);
  font-weight: 570;
}

.fn-sheet-github {
  margin-top: 12px;
  font-weight: 570;
}

/* Transitions */
.fn-pop-enter-active,
.fn-pop-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}

.fn-pop-enter-from,
.fn-pop-leave-to {
  opacity: 0;
  transform: translateY(-6px) scale(0.98);
}

.fn-sheet-enter-active,
.fn-sheet-leave-active {
  transition: opacity 0.22s ease, transform 0.22s ease;
}

.fn-sheet-enter-from,
.fn-sheet-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}

/* Breakpoints */
@media (max-width: 1280px) {
  .fnav-link {
    padding: 8px 10px;
    font-size: 12.5px;
  }
}

@media (max-width: 900px) {
  .fnav-right {
    display: none;
  }

  .fnav-burger {
    display: block;
  }

  .fnav-search :deep(.DocSearch-Button) {
    width: 36px;
    height: 36px;
    justify-content: center;
    padding: 0;
  }

  .fnav-search :deep(.DocSearch-Button-Placeholder),
  .fnav-search :deep(.DocSearch-Button-Keys) {
    display: none;
  }

  .fnav-search :deep(.DocSearch-Search-Icon) {
    width: 16px;
    height: 16px;
  }
}
</style>
