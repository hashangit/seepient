<script setup>
defineProps({
  title: { type: String, required: true },
  columns: { type: Array, required: true },
  rows: { type: Array, required: true },
})
</script>

<template>
  <div class="ttable">
    <p class="ttable-title">{{ title }}</p>
    <table>
      <thead>
        <tr>
          <th v-for="c in columns" :key="c">{{ c }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, i) in rows" :key="i">
          <td v-for="(cell, j) in row" :key="j" :class="{ 'cell-key': j === 0 }">{{ cell }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.ttable {
  margin: 1.75rem 0;
  background: #1a1a1a;
  border: 1px solid rgba(243, 243, 240, 0.09);
  border-radius: 14px;
  padding: 16px 20px;
  font-family: var(--vp-font-family-mono);
  overflow-x: auto;
}

.ttable-title {
  margin: 0 0 12px;
  font-size: 11px;
  letter-spacing: 0.08em;
  color: rgba(226, 226, 220, 0.5);
  white-space: nowrap;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

th {
  text-align: left;
  font-weight: 500;
  color: rgba(226, 226, 220, 0.45);
  border-bottom: 1px solid rgba(243, 243, 240, 0.14);
  padding: 7px 14px 7px 0;
  white-space: nowrap;
}

td {
  padding: 7px 14px 7px 0;
  color: rgba(226, 226, 220, 0.8);
  white-space: nowrap;
}

.cell-key {
  color: #e2e2dc;
}

tbody tr + tr td {
  border-top: 1px solid rgba(243, 243, 240, 0.06);
}
</style>
