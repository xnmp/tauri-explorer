# #599 — config autoreload, and the two ways it can eat your settings

## What was added

A `notify` watch on the app config directory (`src-tauri/src/config_watch.rs`)
emits `config-file-changed` for `settings.json` and `themes/*.css`. The
frontend re-reads the file and applies it live, so editing settings.json in an
editor — or having a dotfile manager rewrite it — takes effect without a
restart. Theme is the case people notice, but every setting participates.

## The hard part is not the watcher

A filesystem watcher reports *that* a file changed, never *who* changed it. The
app rewrites `settings.json` on every settings change, and `write_atomic`
renames a temp file over the destination — indistinguishable from a careful
editor's save. Two failure modes follow, and both are silent:

1. **The write loop.** Adopt our own write → state re-seats → something writes
   again → the watcher fires again.
2. **The revert.** Far worse. Notifications are asynchronous, so the event for
   write N can arrive *after* memory has already moved on to N+1 while N+1 is
   still queued. Reading the file then yields N, and adopting it silently
   undoes the change the user just made.

## How they are prevented

`domain/config-reload.ts` (`decideConfigReload`) is the whole decision, and it
refuses on four grounds, in this order:

| reason | what it catches |
|---|---|
| `self-write-pending` | (2) — a write of ours is queued or in flight, so disk is a stale snapshot we are about to replace |
| `own-write-echo` | (1) — content byte-identical to what we last wrote |
| `unusable` | a file observed mid-save, hand-edited into invalid JSON, or deleted — keep current state rather than wipe it |
| `unchanged` | a reformat that normalizes to the same settings; re-seating would repaint for nothing |

The two facts it needs live in `state/persisted.ts` beside the config writer
that produces them: `isConfigWritePending` and `lastWrittenConfig`.
`lastWrittenConfig` is recorded *before* the await in `writeConfigQueued`,
because the watcher can report the change before `writeConfigFile` resolves.

`reloadFromDisk` checks `isConfigWritePending` both before and after the read:
a settings change made while the file was being read would otherwise be
clobbered by the older disk contents.

## Theme application is imperative, not reactive

Most settings are consumed through `settingsStore.<flag>` and so re-seating the
settings object is enough. The theme is not: it is written onto
`document.documentElement` by `applyTheme`. Anything that changes
`settings.theme` behind the store's back must call `themeStore.syncFromSettings()`
— which is why `handleConfigFileChanged` only does so when `reloadFromDisk`
actually returned true, so an echo stays a no-op all the way through.

User theme CSS needs more than that: `themeStore.initTheme()` re-injects the
`<style>` elements and re-discovers the theme list, which is what lets a
*newly added* `themes/*.css` file resolve as a theme id at all.

## What the Rust side deliberately does not do

It does not try to be clever about authorship — see above, that belongs where
the write bookkeeping is. It also reports only the two file shapes the frontend
acts on (`watched_config_name` is the entire allowlist): the config dir also
holds window state, bookmarks and plugin blobs that the app rewrites
constantly, and forwarding those would be a steady stream of events nothing
listens to.

## Verification

Unit: `tests/domain/config-reload.test.ts` (every rejection path),
`tests/state/config-autoreload.test.ts` (the store reload and the event
routing, including the revert scenario with a write held in flight).
Rust: `watched_config_name` allowlist, including the `.settings.json.tmp-<pid>`
staging file.

Real binary (a browser E2E cannot see a filesystem watcher at all): app run
with a sandboxed `XDG_CONFIG_HOME`, then settings.json rewritten from outside —
theme, sidebar and hidden-files all followed with no restart; a toggle made
back inside the app was not reverted and the file stopped changing after one
write; a `themes/*.css` file added and then edited was picked up and repainted.
Screenshots in `screenshots/feat/config-autoreload/`.
