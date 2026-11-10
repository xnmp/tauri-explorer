# #1580 — a shell (re)started during navigation stayed in the old folder

**Symptom.** With "terminal follows explorer" on, navigating while the shell was
starting (first open or Restart) left the new shell in the previous folder until
the next navigation.

**Cause.** The shell spawns in the path read when the start was requested. The
panel's path effect returned early while `terminalSession.id` was null, and that
id is not reactive, so nothing re-ran the sync once the shell was up. Its
`lastSyncTarget` dedupe also lived in the component, so a path skipped during
the start could be wrongly deduped later.

**Rule.** Don't gate a reconcile on non-reactive readiness inside an effect.
Record the latest followed path regardless of readiness (`cwdSync.follow`) and
reconcile once when the resource becomes ready (`startFollowingShell` →
`shellStarted`, which writes no cd when the shell is already where it spawned).
Keep the dedupe with the state machine that consumes it, not in the component.
The session id goes live a few microtasks before its start resolves; the dedupe
records which shell a path was synced to, so a navigation landing in that gap
is not cd'd twice.
Tests: `tests/state/terminal-follow-start.test.ts` (real session + controller).
The browser fixture cannot start a shell (no Tauri event system), so this is
covered in Vitest, not Playwright.
