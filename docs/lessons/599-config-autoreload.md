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
   undoes the change the user just made — durably, since memory and disk then
   disagree and the next ordinary save writes the reverted object back.

**A boolean "is a write pending" does not catch (2).** This is the part worth
remembering; the first implementation got it wrong and an adversarial review
found it. Sampling the flag before and after the read misses a write that
*starts and finishes entirely inside* the read window:

```
t0  reloadFromDisk: pending === false
t1  await readConfigFile(…)          ← IPC in flight, disk still holds D
t2  user toggles a setting → write(N) issued AND completed
t3  read resolves with D (snapshot from before t2)
      pending === false at both ends → adopt D → the toggle is reverted
```

The fix is a monotonic **write generation counter** per file
(`configWriteActivity` / `configWriteRaced` in `state/persisted.ts`), sampled
on both sides of the read. "Did any write of ours overlap this read" is
answerable however the timing lands; "is a write pending right now" is not.

## How they are prevented

`domain/config-reload.ts` (`decideConfigReload`) is the whole decision, and it
refuses on four grounds, in this order:

| reason | what it catches |
|---|---|
| `self-write-overlap` | (2) — a write of ours overlapped the read, whether it straddled the window or began and ended inside it |
| `own-write-echo` | (1) — content byte-identical to what we last wrote |
| `unusable` | a file observed mid-save, hand-edited into invalid JSON, or deleted — keep current state rather than wipe it |
| `unchanged` | a reformat that normalizes to the same settings; re-seating would repaint for nothing |

The facts it needs live in `state/persisted.ts` beside the config writer that
produces them: `configWriteActivity`/`configWriteRaced` and `lastWrittenConfig`.
Both the last-written content and the generation counter are recorded *before*
the await in `writeConfigQueued`, because the watcher can report the change
before `writeConfigFile` resolves.

`reloadFromDisk` returns the *reason*, not a boolean, so callers can
distinguish "nothing to do" from "your file is broken" — see the toast below.

## Theme application is imperative, not reactive

Most settings are consumed through `settingsStore.<flag>` and so re-seating the
settings object is enough. The theme is not: it is written onto
`document.documentElement` by `applyTheme`. Anything that changes
`settings.theme` behind the store's back must call `themeStore.syncFromSettings()`
— which is why `handleConfigFileChanged` only does so when `reloadFromDisk`
reports `external-change`, so an echo stays a no-op all the way through.

User theme CSS needs more than that: `themeStore.initTheme()` re-injects the
`<style>` elements and re-discovers the theme list, which is what lets a
*newly added* `themes/*.css` file resolve as a theme id at all.

### An unknown theme id is not a no-op

`applyTheme` will happily set `data-theme="typo"` — nothing styles that, and
the app repaints into an unstyled palette. Before autoreload that was only
reachable at startup; hand-editing `"theme"` in settings.json makes it a live
path, so every entry point now goes through `resolveThemeId` (in
`domain/theme-list.ts`, where it is unit-testable).

The fallback is deliberately **not** written back to settings. A user theme can
be missing for a temporary reason — file moved, `listUserThemes` failed once —
and persisting the substitute would turn that into permanent loss of the user's
choice. That is only safe because *every reader resolves*: `syncFromSettings`
compares the resolved id, so an unpersisted fallback is not undone by the next
reload re-applying the missing name. `initTheme` resolves from
`settingsStore.theme` rather than the live id, so restoring the CSS file
restores the theme.

### Silence is the wrong answer to a typo

A parse failure used to make the reload a no-op with no feedback at all. To a
user who just hand-edited settings.json that reads as "autoreload is broken",
not "your JSON has a typo" — while the settings they can see are no longer the
ones they wrote. `unusable` therefore raises a toast; the other three
rejections stay silent, because they are all normal.

## What the Rust side deliberately does not do

It does not try to be clever about authorship — see above, that belongs where
the write bookkeeping is. It also reports only the two file shapes the frontend
acts on (`watched_config_name` is the entire allowlist): the config dir also
holds window state, bookmarks and plugin blobs that the app rewrites
constantly, and forwarding those would be a steady stream of events nothing
listens to. Extending the set is #605.

## Known limitation: symlinks

The watch is on the **canonicalized** config dir, which covers a dotfile
manager that symlinks the whole directory (and matches macOS FSEvents, which
reports canonical paths). A symlinked *individual file* inside a real config
dir — the common GNU stow / chezmoi layout — is not covered: inotify watches
the link, not the target, so writes through the target produce no event at all.
Tracked as #604.

## Verification

Unit: `tests/domain/config-reload.test.ts` (every rejection path),
`tests/state/config-autoreload.test.ts` (the store reload and the event
routing, including both revert scenarios — a write held in flight, and a write
that starts and completes inside the read window; the latter fails against a
pending-flag-only guard), `tests/theme-list.test.ts` (`resolveThemeId`).
Rust: `watched_config_name` allowlist, including the `.settings.json.tmp-<pid>`
staging file.

Real binary (a browser E2E cannot see a filesystem watcher at all): app run
with a sandboxed `XDG_CONFIG_HOME`, then settings.json rewritten from outside —
theme, sidebar and hidden-files all followed with no restart; a toggle made
back inside the app was not reverted and the file stopped changing after one
write; a `themes/*.css` file added and then edited was picked up and repainted.
Screenshots in `screenshots/feat/config-autoreload/`.
