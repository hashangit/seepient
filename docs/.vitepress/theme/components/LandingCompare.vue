<script setup lang="ts">
const rows = [
  { cap: 'Permission policy & consent modes', seepient: 'Built-in', diy: 'Bolt-on, if any' },
  { cap: 'OS-level process sandbox', seepient: 'Seatbelt · Bubblewrap', diy: '—' },
  { cap: 'Exact atomic file commits', seepient: 'Native helper', diy: 'Best-effort writes' },
  { cap: 'Durable, replayable audit trail', seepient: 'Append-only', diy: 'Console.log' },
  { cap: 'Purpose × tier model routing', seepient: 'Live catalog', diy: 'Hardcoded names' },
  { cap: 'Embedder-owned storage (SDK)', seepient: 'Store contracts', diy: '—' },
]
</script>

<template>
  <section class="lp-section compare">
    <header class="compare-head" v-reveal>
      <span class="lp-kicker">Why Seepient</span>
      <h2 class="lp-h2 compare-title">
        <span class="soft">Built for production agents.</span><br />
        Not demo loops.
      </h2>
      <p class="lp-lede compare-lede">
        The gap between a chat completion and an agent you can leave unattended
        is everything around the model call. Seepient ships that everything.
      </p>
    </header>

    <div class="compare-table" v-reveal>
      <table>
        <thead>
          <tr>
            <th scope="col">Capability</th>
            <th scope="col" class="col-seepient">Seepient</th>
            <th scope="col">Typical DIY loop</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.cap">
            <td class="cell-cap">{{ row.cap }}</td>
            <td class="col-seepient">
              <span class="cell-seepient"><span class="check" aria-hidden="true">✓</span> {{ row.seepient }}</span>
            </td>
            <td class="cell-diy">{{ row.diy }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.compare-head {
  max-width: 620px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 22px;
}

.compare-lede {
  margin-top: 2px;
}

.compare-table {
  max-width: 860px;
  margin: 56px auto 0;
}

.compare-table table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  border: 1px solid var(--glass-border);
  border-radius: 14px;
  overflow: hidden;
  background: var(--glass-bg);
  backdrop-filter: var(--glass-filter);
  -webkit-backdrop-filter: var(--glass-filter);
  box-shadow: var(--glass-shadow-sm);
}

.compare-table th {
  font-family: var(--vp-font-family-mono);
  font-size: 10.5px;
  font-weight: 500;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--ink-3);
  text-align: left;
  padding: 14px 18px;
  background: rgba(255, 255, 255, 0.42);
  border-bottom: 1px solid rgba(19, 19, 17, 0.1);
}

.compare-table td {
  padding: 13px 18px;
  border-bottom: 1px solid var(--line);
  font-size: 13.5px;
  color: var(--ink-2);
}

.compare-table tbody tr:last-child td {
  border-bottom: none;
}

.compare-table tbody tr:hover .cell-cap,
.compare-table tbody tr:hover .cell-diy {
  background: rgba(255, 255, 255, 0.5);
}

.cell-cap {
  font-weight: 530;
  color: var(--ink) !important;
}

.col-seepient {
  background: rgba(237, 239, 220, 0.62);
  border-left: 1px solid var(--line);
  border-right: 1px solid var(--line);
}

.col-seepient th,
th.col-seepient {
  background: #e4e8cd;
  color: var(--moss-deep) !important;
}

.cell-seepient {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--ink);
  font-weight: 550;
}

.check {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--moss);
  color: #fff;
  font-size: 10px;
}

.cell-diy {
  color: var(--ink-3) !important;
}

@media (max-width: 720px) {
  .compare-table {
    overflow-x: auto;
  }

  .compare-table table {
    min-width: 560px;
  }
}
</style>
