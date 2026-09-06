<template>
  <section class="activity" aria-label="Live runtime activity">
    <div class="activity-inner">
      <span class="activity-label">
        <span class="pulse" aria-hidden="true"></span>
        Live runtime activity
      </span>
      <ul class="activity-list">
        <li><span class="tick">✓</span> permission granted — execute_shell_command</li>
        <li><span class="tick">✓</span> exact commit verified — 4f2c9a1</li>
        <li><span class="tick">↳</span> model routed — language · complex tier</li>
        <li><span class="tick">✓</span> sandbox entered — seatbelt profile</li>
        <li><span class="tick">↳</span> skill activated — release-notes</li>
        <li><span class="tick">✓</span> session resumed — 128 messages</li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.activity {
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
  background: var(--glass-bg);
  backdrop-filter: var(--glass-filter);
  -webkit-backdrop-filter: var(--glass-filter);
}

.activity-inner {
  max-width: 1200px;
  margin: 0 auto;
  padding: 22px 32px;
  display: flex;
  align-items: baseline;
  gap: 40px;
}

.activity-label {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 9px;
  font-family: var(--vp-font-family-mono);
  font-size: 10px;
  font-weight: 550;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--ink-2);
}

.pulse {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--moss);
  animation: pulse 2.4s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.25; }
}

@media (prefers-reduced-motion: reduce) {
  .pulse {
    animation: none;
  }
}

.activity-list {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 34px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.activity-list li {
  font-family: var(--vp-font-family-mono);
  font-size: 11.5px;
  color: var(--ink-2);
  white-space: nowrap;
}

.tick {
  color: var(--moss);
  margin-right: 7px;
}

@media (max-width: 960px) {
  .activity-inner {
    flex-direction: column;
    gap: 14px;
  }
}
</style>
