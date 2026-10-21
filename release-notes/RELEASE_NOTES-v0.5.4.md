# Seepient v0.5.4 Release Notes

**Seepient v0.5.4** fixes a critical event-loop drain bug during first-run onboarding where `readline.close()` left `process.stdin` paused before handing off to Ink, causing Node 22/26 to exit prematurely with code 13 and an "unsettled top-level await" warning. It also integrates Ink's native `waitUntilExit()` promise in `runSetupWizard` to ensure clean exit settlement on all unmount paths (including Ctrl+C / SIGINT).

---

## 🔧 Fixes & Improvements

### First-Run Setup Wizard Event Loop Drain & Unmount Settlement
- **Stdin Resume on Wizard Entry**: Explicitly calls `process.stdin.resume()` in `runSetup()` before launching Ink's setup wizard, keeping the TTY stream active so the Node event loop does not drain and terminate.
- **Native Ink Unmount Lifecycle**: Replaced the hand-rolled wrapper promise in `runSetupWizard()` with `await instance.waitUntilExit()`, ensuring that any unmount (such as keyboard interrupt via Ctrl+C) settles the promise cleanly without hanging or emitting unhandled top-level await warnings.
- **Test Isolation & Side-Effect Prevention**: Added dedicated regression test suites pinning stdin resume behavior and callback-free unmount settlement, with filesystem mocking to prevent unneeded directory creation during test execution.
