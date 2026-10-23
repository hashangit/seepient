#!/usr/bin/env node
// Spawn `tsx watch` with stdin ignored, and restart it when it dies on its own.
//
// 1. tsx watch listens on stdin for its press-Return-to-restart shortcut. Under turbo on Windows
//    that inherited handle never delivers and never closes, and the watched service then never
//    reaches its entrypoint: no output, no port, no error. These services are non-interactive, so
//    nothing is lost. The redirect lives here rather than in the dev scripts because `< NUL` and
//    `< /dev/null` differ.
// 2. A workspace rebuild wipes `dist/` before re-emitting. A tsx watch that restarts inside that
//    window fails to resolve just-rebuilt modules and exits, taking the service down until a human
//    notices. The watcher treats a nonzero child exit as a restartable crash: back off briefly and
//    respawn, so a rebuild racing a restart self-heals. Signals still propagate (Ctrl-C stops the
//    service), a signal landing inside the restart window exits instead of resurrecting the
//    service (round-5 gate), and a crash loop (5 fast exits without a 30s-stable run) gives up
//    loudly with a nonzero exit instead of spinning forever.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");

const RESTART_DELAY_MS = 1_000;
const STABLE_RUN_MS = 30_000;
const MAX_CONSECUTIVE_RESTARTS = 5;

let child;
let consecutiveRestarts = 0;
let stopping = false;
let restartTimer;

function exitForSignal(signal) {
  // Conventional shell exit statuses so supervisors see why we stopped.
  process.exit(signal === "SIGINT" ? 130 : 143);
}

const onSignal = (signal) => {
  stopping = true;
  if (restartTimer) {
    // Child already died; a restart was pending. A stop request must not
    // resurrect the service — clear the timer and exit now.
    clearTimeout(restartTimer);
    restartTimer = undefined;
    exitForSignal(signal);
  }
  child?.kill(signal);
};
process.on("SIGINT", () => onSignal("SIGINT"));
process.on("SIGTERM", () => onSignal("SIGTERM"));

function startChild() {
  if (stopping) return;
  // A fired timer's handle stays truthy; without this reset every later
  // signal would take the "restart was pending" branch and orphan the live
  // child instead of stopping it (round-5 gate).
  restartTimer = undefined;
  const startedAt = Date.now();
  child = spawn(process.execPath, [tsxCli, "watch", ...process.argv.slice(2)], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  child.on("exit", (code, signal) => {
    if (stopping || signal) {
      if (signal) process.kill(process.pid, signal);
      process.exit(code ?? (stopping ? 0 : 1));
      return;
    }
    if (Date.now() - startedAt >= STABLE_RUN_MS) consecutiveRestarts = 0;
    consecutiveRestarts += 1;
    if (consecutiveRestarts > MAX_CONSECUTIVE_RESTARTS) {
      console.error(
        `[dev-watch] child exited ${MAX_CONSECUTIVE_RESTARTS} times without a stable run — giving up`,
      );
      // A crash loop is a failure even when the last exit was clean.
      process.exit(1);
      return;
    }
    console.error(
      `[dev-watch] child exited (code ${code}) — restarting in ${RESTART_DELAY_MS}ms ` +
        `(${consecutiveRestarts}/${MAX_CONSECUTIVE_RESTARTS})`,
    );
    restartTimer = setTimeout(startChild, RESTART_DELAY_MS);
  });
}

startChild();
