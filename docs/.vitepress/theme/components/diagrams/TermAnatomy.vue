<script setup>
import { computed } from 'vue'

const props = defineProps({
  regions: { type: Array, required: true },
})

// Normalize feed lines: strings starting with "- "/" + " group into diff rows,
// and a line like "Diff: path" opens a bordered diff block.
function classify(line) {
  if (typeof line !== 'string') return line
  if (line.startsWith('- ')) return { diffRow: { k: 'del', t: line } }
  if (line.startsWith('+ ')) return { diffRow: { k: 'add', t: line } }
  return { text: line }
}

const blocks = computed(() =>
  props.regions.map((r) => ({
    ...r,
    blocks: (function build(lines) {
      const out = []
      let diff = null
      for (const raw of lines) {
        const c = classify(raw)
        if (c.diffRow) {
          if (!diff) {
            diff = { diff: { title: '', rows: [] } }
            out.push(diff)
          }
          diff.diff.rows.push(c.diffRow)
        } else if (typeof raw === 'string' && raw.startsWith('Diff: ')) {
          diff = { diff: { title: raw.slice(6), rows: [] } }
          out.push(diff)
        } else {
          diff = null
          out.push({ text: raw })
        }
      }
      return out
    })(r.lines),
  })),
)
</script>

<template>
  <div class="tanat">
    <div v-for="region in blocks" :key="region.label" class="tanat-region" :class="`tanat-${region.kind}`">
      <div class="tanat-screen">
        <template v-for="(b, i) in region.blocks" :key="i">
          <p v-if="b.text !== undefined" class="tline" :class="{ 'tline-prompt': b.text.startsWith('> ') }">{{ b.text }}</p>
          <div v-else class="tdiff">
            <p class="tdiff-title">{{ b.diff.title }}</p>
            <p
              v-for="(row, j) in b.diff.rows"
              :key="j"
              class="tline tdiff-row"
              :class="row.k === 'add' ? 'tdiff-add' : 'tdiff-del'"
            >{{ row.t }}</p>
          </div>
        </template>
      </div>
      <div class="tanat-label">
        <span class="tanat-tick" aria-hidden="true"></span>
        <span class="tanat-label-text">{{ region.label }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tanat {
  margin: 1.75rem 0;
  background: #1a1a1a;
  border: 1px solid rgba(243, 243, 240, 0.09);
  border-radius: 14px;
  overflow: hidden;
  font-family: var(--vp-font-family-mono);
}

.tanat-region {
  display: grid;
  grid-template-columns: 1fr 200px;
}

.tanat-region + .tanat-region {
  border-top: 1px solid rgba(243, 243, 240, 0.08);
}

.tanat-screen {
  padding: 14px 18px;
  overflow-x: auto;
}

.tanat-header .tanat-screen {
  padding: 11px 18px;
  border-bottom: 1px solid rgba(243, 243, 240, 0.08);
}

.tanat-bar .tanat-screen,
.tanat-input .tanat-screen {
  padding: 11px 18px;
}

.tline {
  margin: 0;
  font-size: 12px;
  line-height: 1.75;
  color: rgba(226, 226, 220, 0.78);
  white-space: pre;
}

.tline-prompt {
  color: #e2e2dc;
}

.tline-prompt::first-letter {
  color: #a3b368;
}

.tdiff {
  margin: 10px 0;
  border: 1px solid rgba(243, 243, 240, 0.16);
  border-radius: 8px;
  padding: 8px 12px;
}

.tdiff-title {
  font-size: 11px;
  color: rgba(226, 226, 220, 0.5);
  margin-bottom: 4px;
}

.tdiff-row.tdiff-del {
  color: #e08b82;
}

.tdiff-row.tdiff-add {
  color: #9cc37a;
}

/* Annotation labels */
.tanat-label {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-left: 14px;
  border-left: 1px solid rgba(243, 243, 240, 0.08);
}

.tanat-tick {
  width: 18px;
  height: 1px;
  background: rgba(143, 166, 90, 0.7);
  flex-shrink: 0;
}

.tanat-label-text {
  font-size: 11px;
  letter-spacing: 0.04em;
  color: rgba(243, 243, 240, 0.55);
}

@media (max-width: 860px) {
  .tanat-region {
    grid-template-columns: 1fr;
  }

  .tanat-label {
    border-left: none;
    padding: 0 18px 10px;
  }

  .tanat-tick {
    display: none;
  }

  .tanat-label-text {
    color: #8fa65a;
    text-transform: uppercase;
    font-size: 9.5px;
    letter-spacing: 0.14em;
  }

  .tline {
    white-space: normal;
  }
}
</style>
