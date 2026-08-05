# #584 — Unguarded lazy dialog import soft-locks all hotkeys

**Symptom:** "Switch Theme..." from the command palette did nothing in the installed app, and afterwards every keyboard shortcut except Escape was dead.

**Root cause:** All code-split dialogs were loaded in `+page.svelte` via `void import(...).then(...)` with no `.catch`. The dialog's `dialogStore` open-flag is set *before* the chunk loads; on a failed fetch the rejection was silent, the component stayed `null` (nothing rendered), and the stuck flag fed `dialogStore.hasModalOpen`, which gates the global keydown handler — an invisible modal blocking all shortcuts. Not theme-specific: all 12 lazy dialogs shared the pattern.

**Fix:** `domain/lazy-dialog.ts` (`loadDialogComponent`) makes rollback mandatory: on import rejection it closes the dialog (per-dialog `dialogStore` close action; `conflictResolver.resolve("cancel")` for the conflict dialog) and shows an error toast.

**Gotchas worth remembering:**
- `void import(...)` discards the rejection too — `void` is not error handling. Any "set flag, then lazy-load the thing the flag reveals" pattern needs a failure path that resets the flag.
- Browsers cache a **failed** dynamic-import in the page's module map: retrying the same `import()` re-rejects until reload/restart. Don't design an in-page retry around a static specifier; fail safe and tell the user to restart.
- To reproduce a chunk-load failure in Playwright: `page.route("**/ThemePicker.svelte*", r => r.abort())` — see `e2e/lazy-dialog-failure.spec.ts`.
- A plausible real-world trigger for the installed app: a dev-mode binary (bare `cargo build --release` without `tauri/custom-protocol`) dialing a Vite server serving a different branch — one hash-mismatched chunk fails while the rest of the app works.
