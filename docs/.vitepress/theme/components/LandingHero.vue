<script setup lang="ts">
import { withBase } from 'vitepress'

const shore = `${withBase('/textures/shore.jpg')}`
</script>

<template>
  <section class="hero">
    <div class="hero-inner">
      <p class="pixel-banner" v-reveal>SEEPIENT AGENT</p>
      <h1 class="hero-title" v-reveal>
        <span class="soft">The complete runtime for</span><br />
        <span>an autonomous agent species.</span>
      </h1>
      <p class="hero-sub" v-reveal>
        Seepient pairs a full-screen terminal UI with a CLI, a TypeScript SDK,
        and a standalone server — one agent loop, one permission engine, one
        audit trail across all of them.
      </p>
      <div class="hero-actions" v-reveal>
        <a class="lp-btn lp-btn--ink" href="/seepient/guides/quick-start">Get started</a>
        <a class="lp-btn lp-btn--ghost" href="https://github.com/hashangit/seepient">Star on GitHub</a>
      </div>
    </div>

    <div class="hero-stage">
      <div class="hero-shore" :style="{ backgroundImage: `url(${shore})` }" aria-hidden="true"></div>

      <div class="terminal" v-reveal role="img" aria-label="Seepient terminal session running a coding task">
        <div class="terminal-body">
          <div class="msg msg--user">
            <p class="msg-label">You</p>
            <p class="msg-text">Add token-bucket rate limiting to the payments API</p>
          </div>

          <div class="msg msg--tool">
            <p class="msg-text">
              <span class="t-ok">✓</span> execute_shell_command
              <span class="t-dim">{"cmd":"npm test -- payments"}</span>
              <span class="t-dim">(2.1s)</span>
            </p>
            <p class="msg-text t-dim">↳ 38 passed, 0 failed</p>
          </div>

          <div class="msg msg--tool">
            <p class="msg-text">
              <span class="t-ok">✓</span> write_file
              <span class="t-dim">{"file":"src/middleware/rate-limit.ts"}</span>
              <span class="t-dim">(0.8s)</span>
            </p>
            <p class="msg-text"><span class="t-moss">committed 4f2c9a1</span> <span class="t-dim">· pre-image verified</span></p>
          </div>

          <div class="msg msg--agent">
            <p class="msg-label">Seepient</p>
            <p class="msg-text">
              Rate limiting is wired in — 60 req/min per API token with burst
              allowance. All 38 tests pass.
            </p>
          </div>

          <div class="tui-input">
            <span class="tui-caret">›</span>
            <span class="tui-placeholder">Ask Seepient Agent — type / for commands, @ for files</span>
          </div>
        </div>
        <div class="terminal-status">
          <span class="st-provider">openrouter</span>
          <span class="st-sep">|</span>
          <span class="st-model">openrouter/free</span>
          <span class="st-sep">|</span>
          <span class="st-dim">11k/200k (6%)</span>
          <span class="st-sep">|</span>
          <span class="st-dim">$0.00</span>
          <span class="st-sep">|</span>
          <span class="st-mode">mode: autonomous</span>
          <span class="st-sep">|</span>
          <span class="st-dim">143 skills</span>
          <span class="st-sep">|</span>
          <span class="st-commit">exact commits: on</span>
        </div>
      </div>

      <aside class="approval" v-reveal aria-label="Permission request card">
        <p class="approval-kicker">Permission request</p>
        <p class="approval-path">fs.write → src/middleware/rate-limit.ts</p>
        <div class="approval-actions">
          <span class="approval-btn approval-btn--ghost">Allow once</span>
          <span class="approval-btn approval-btn--ink">This session</span>
        </div>
        <p class="approval-meta">sandbox: seatbelt · exact commit</p>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.hero {
  padding: 148px 24px 0;
  position: relative;
}

.hero-inner {
  max-width: 980px;
  margin: 0 auto;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
}

/* Pixel logotype — the TUI banner, recreated for the web */
.pixel-banner {
  margin: 0 0 30px;
  font-family: 'Silkscreen', var(--vp-font-family-mono);
  font-weight: 400;
  font-size: clamp(21px, 3vw, 33px);
  letter-spacing: 0.08em;
  line-height: 1;
  background: linear-gradient(
    90deg,
    #e8907e 0%,
    #ee9d6c 11%,
    #f2b25f 22%,
    #e8c862 33%,
    #c6ce6a 43%,
    #9bc468 52%,
    #6fbf83 61%,
    #63c6b8 70%,
    #6bb8d6 79%,
    #6f9fe0 88%,
    #a98be0 100%
  );
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

.hero-title {
  font-family: var(--vp-font-family-heading);
  font-size: clamp(2.8rem, 5.6vw, 4.6rem);
  font-weight: 700;
  letter-spacing: -0.045em;
  line-height: 0.99;
  margin: 34px 0 0;
  color: var(--ink);
}

.hero-title .soft {
  color: var(--ink-3);
}

.hero-sub {
  max-width: 580px;
  margin: 26px 0 0;
  font-size: 16.5px;
  line-height: 1.65;
  color: var(--ink-2);
}

.hero-actions {
  display: flex;
  gap: 12px;
  margin-top: 34px;
  flex-wrap: wrap;
  justify-content: center;
}

/* Stage: terminal floating above the shore texture */
.hero-stage {
  position: relative;
  max-width: 1200px;
  margin: 84px auto 0;
  padding-bottom: 96px;
}

.hero-shore {
  position: absolute;
  left: 50%;
  bottom: 0;
  transform: translateX(-50%);
  width: 100vw;
  height: 300px;
  background-size: cover;
  background-position: center 68%;
  -webkit-mask-image: linear-gradient(180deg, transparent 0%, #000 42%);
  mask-image: linear-gradient(180deg, transparent 0%, #000 42%);
  opacity: 0.9;
}

.terminal {
  position: relative;
  z-index: 1;
  width: min(860px, 100%);
  margin: 0 auto;
  background: #1a1a1a;
  border: 1px solid rgba(243, 243, 240, 0.09);
  border-radius: 14px;
  box-shadow: 0 60px 120px -40px rgba(19, 19, 17, 0.55), 0 24px 48px -24px rgba(19, 19, 17, 0.35);
  overflow: hidden;
}

.terminal-body {
  padding: 22px 22px 18px;
  font-family: var(--vp-font-family-mono);
  font-size: 12.5px;
  line-height: 1.7;
}

/* TUI message boxes — mirrors the real interface */
.msg {
  border: 1px solid;
  border-radius: 8px;
  padding: 10px 14px;
  margin-bottom: 14px;
}

.msg--user {
  border-color: rgba(163, 179, 104, 0.85);
  max-width: 480px;
}

.msg--tool {
  border-color: rgba(224, 139, 82, 0.75);
  max-width: 560px;
}

.msg--agent {
  border-color: rgba(122, 143, 217, 0.8);
}

.msg--agent .msg-text {
  max-width: 60ch;
}

.msg-label {
  margin: 0 0 3px;
  font-size: 11px;
  font-weight: 600;
}

.msg--user .msg-label { color: #a3b368; }
.msg--agent .msg-label { color: #8b9de4; }

.msg-text {
  margin: 0;
  color: #e2e2dc;
  overflow-wrap: break-word;
  white-space: pre-wrap;
}

.t-ok { color: #a3b368; }
.t-moss { color: #a3b368; }
.t-dim { color: rgba(226, 226, 220, 0.45); }

/* Input box */
.tui-input {
  display: flex;
  align-items: center;
  gap: 10px;
  border: 1px solid rgba(163, 179, 104, 0.85);
  border-radius: 8px;
  padding: 10px 14px;
  margin-top: 4px;
}

.tui-caret {
  color: #a3b368;
  font-weight: 600;
}

.tui-placeholder {
  color: rgba(226, 226, 220, 0.4);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Status line — color-coded segments, as in the real TUI */
.terminal-status {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 11px 22px;
  border-top: 1px solid rgba(243, 243, 240, 0.08);
  font-family: var(--vp-font-family-mono);
  font-size: 10.8px;
  letter-spacing: 0.01em;
  white-space: nowrap;
  overflow: hidden;
}

.st-sep { color: rgba(226, 226, 220, 0.22); }
.st-provider { color: #d98e4f; }
.st-model { color: #8b9de4; }
.st-mode { color: #d98e4f; }
.st-commit { color: #a3b368; }
.st-dim { color: rgba(226, 226, 220, 0.42); }

/* Floating permission card */
.approval {
  position: absolute;
  z-index: 2;
  right: max(24px, calc(50% - 700px));
  bottom: 118px;
  width: 296px;
  background: rgba(255, 255, 255, 0.78);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  border: 1px solid rgba(255, 255, 255, 0.8);
  border-radius: 14px;
  padding: 16px 18px;
  box-shadow: 0 32px 64px -28px rgba(19, 19, 17, 0.4);
}

.approval-kicker {
  margin: 0;
  font-family: var(--vp-font-family-mono);
  font-size: 10px;
  font-weight: 550;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--ink-3);
}

.approval-path {
  margin: 8px 0 0;
  font-family: var(--vp-font-family-mono);
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--ink);
  word-break: break-all;
}

.approval-actions {
  display: flex;
  gap: 8px;
  margin-top: 14px;
}

.approval-btn {
  flex: 1;
  text-align: center;
  border-radius: 999px;
  padding: 8px 0;
  font-size: 12px;
  font-weight: 560;
}

.approval-btn--ink {
  background: var(--ink);
  color: var(--paper);
}

.approval-btn--ghost {
  border: 1px solid var(--line);
  color: var(--ink-2);
  background: rgba(255, 255, 255, 0.5);
}

.approval-meta {
  margin: 12px 0 0;
  font-family: var(--vp-font-family-mono);
  font-size: 10px;
  letter-spacing: 0.06em;
  color: var(--ink-3);
}

@media (max-width: 960px) {
  .hero {
    padding-top: 120px;
  }

  .hero-stage {
    margin-top: 56px;
    padding-bottom: 56px;
  }

  .approval {
    position: relative;
    right: auto;
    bottom: auto;
    width: min(340px, 92%);
    margin: -36px auto 0;
  }

  .terminal-body {
    font-size: 11.5px;
  }
}
</style>
