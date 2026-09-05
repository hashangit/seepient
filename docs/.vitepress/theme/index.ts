import { h } from 'vue'
import DefaultTheme from 'vitepress/theme'
import CopyMarkdownButton from './CopyMarkdownButton.vue'
import DiagramFlow from './components/diagrams/DiagramFlow.vue'
import DiagramMap from './components/diagrams/DiagramMap.vue'
import DiagramStates from './components/diagrams/DiagramStates.vue'
import TermAnatomy from './components/diagrams/TermAnatomy.vue'
import TermMenu from './components/diagrams/TermMenu.vue'
import TermTable from './components/diagrams/TermTable.vue'
import TermDiff from './components/diagrams/TermDiff.vue'
import '@fontsource-variable/inter'
import '@fontsource-variable/inter-tight'
import '@fontsource-variable/jetbrains-mono'
import '@fontsource/silkscreen'
import './custom.css'

/**
 * Scroll-triggered reveal. Adds .will-reveal immediately and swaps it for
 * .revealed the first time the element enters the viewport.
 */
const reveal = {
  mounted(el: HTMLElement) {
    if (typeof window === 'undefined') return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    el.classList.add('will-reveal')
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            el.classList.add('revealed')
            observer.disconnect()
          }
        }
      },
      { threshold: 0.12 },
    )
    observer.observe(el)
  },
}

export default {
  extends: DefaultTheme,
  Layout: () => h(DefaultTheme.Layout, null, {
    'layout-top': () => h(CopyMarkdownButton),
  }),
  enhanceApp({ app }) {
    app.directive('reveal', reveal)
    // Diagram primitives, usable from any markdown file
    app.component('DiagramFlow', DiagramFlow)
    app.component('DiagramMap', DiagramMap)
    app.component('DiagramStates', DiagramStates)
    app.component('TermAnatomy', TermAnatomy)
    app.component('TermMenu', TermMenu)
    app.component('TermTable', TermTable)
    app.component('TermDiff', TermDiff)
  },
}
