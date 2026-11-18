# TXBridge: the real app on the site

The site demo is the real Tauri Explorer frontend, built with `VITE_SITE_DEMO=1`, running on the
browser mock backend. It is fed a `TX_FS` fixture by the page that embeds it. Everything you see
(listings, previews, Quick Open, Search in Files, the Recycle Bin, the terminal, the git graph,
themes, layouts, keybindings) is the shipping code.

```sh
bun run build:demo     # → build-demo/ (gitignored), base path /app/
bun run demo:serve     # http://127.0.0.1:1455/real.html?fs=station  (PORT=… overrides)
```

`demo:serve` serves `overhaul/` at `/`, falls back to `website-rehaul/` (so `../peel-mock/assets/`
resolves) and serves the build at `/app/`. A deployment must do the same: **the app has to be
same-origin with the host page** (both sides check `event.origin`).

`real.html?fs=station|expedition|archive|default` is the harness: a full-viewport demo, a strip of
buttons for every request, and a live event log. An unknown `fs` boots the built-in fixtures.

## Mounting

```html
<script src="bridge/tx-bridge.js"></script>
<script src="content/fs-station.js"></script>
<script>
  TXBridge.mount(document.querySelector("#stage"), {
    appUrl: "/app/",               // default
    fixture: TX_FS.station,        // omitted → the built-in mock fixtures
    assetBase: location.href,      // what fixture-relative src/poster URLs resolve against (default: this page)
    user: "tomas",                 // default: users[0]
    startPath: "/home/tomas/Pictures",  // default: the user's home
    settings: { theme: "nord", layoutTheme: "floating-islands", showPreviewPane: true },
    keybindings: { "view.toggleSidebar": "Ctrl+B" },   // null = unbound
    requestTimeoutMs: 15000,       // default; every request rejects after this (0 = never)
    mountTimeoutMs: 0,             // default 0 = wait for ready indefinitely
  }).then((stage) => {
    stage.catalog;  // what getCatalog() returns, as of ready
    stage.state;    // what getState() returns, as of ready
    stage.boot;     // { fixture: "provided" | "builtin", error, warnings }, see Boot report
    stage.on("open-external", (file) => showNativeApp(file));
  });
</script>
```

`mount(iframe | container, opts)` resolves when the app reports `ready` (and rejects after
`mountTimeoutMs`, when set). Pass a container and it creates a 100% × 100% iframe. Every stage
method returns a promise, which rejects after `requestTimeoutMs` (`stage.call.withTimeout(ms,
method, ...params)` overrides it for one call), when the frame reloads (its pending answers can
never arrive), or when `stage.destroy()` is called.

### Boot report

The app never boots blank. Fields it cannot use are dropped with a warning (an `assetBase` that is
not an http(s) URL, settings that are not a JSON object, a `startPath` that is not a folder in the
fixture, unrepresentable dates); if the fixture itself cannot be read or installed, the built-in
mock fixtures serve instead. Either way `ready` carries `boot: { fixture, error, warnings }`
(`fixture` is `"builtin"` and `error` says why when yours is not served), also logged to the
frame's console.

With a fixture the sidebar's Bookmarks are exactly the user's `bookmarks` (or, when the user has
none listed, the visible folders in their home); the desktop's default system folders are hidden,
and the File Recovery records the built-in fixtures carry are gone.

The app keeps its storage in memory: every load starts from `init`, and nothing touches the host
page's `localStorage`. Reloading the frame replays the same `init`.

## Wire protocol (v1)

Every message is `{ tx: "tauri-explorer", v: 1, type, … }`, posted with the page origin as the
target. Messages from any other window, origin or version are ignored.

| Direction | `type` | Body |
|---|---|---|
| app → host | `hello` | — (sent once at boot to a same-origin parent; the app waits up to 5 s for `init`, then boots the built-in fixtures; without a same-origin parent it boots them at once) |
| host → app | `init` | `fixture?`, `assetBase?`, `user?`, `settings?`, `keybindings?`, `startPath?` |
| host → app | `request` | `id` (string or number), `method`, `params: []` |
| app → host | `response` | `id`, `ok`, `result` or `error` |
| app → host | `event` | `event`, `data` |

`hello`/`init` happen before any app module loads, so the first listing is already the fixture.

### Requests (stage methods)

| Method | Params → result |
|---|---|
| `getState()` | → `{ path, panes: [{index, paneId, path, viewMode, selection, active}], settings, theme, panels, keybindings, media, trashCount }` (`trashCount`: items in the Recycle Bin) |
| `getCatalog()` | → see Catalog |
| `setSettings(partial)` | any keys of the app's `Settings` (unknown keys and bad values are dropped by the app's own normalizer) → the full settings. `theme` must be a catalog theme id. `millerLayers` and `viewMode` are each new pane's default; the bridge also applies them to the open panes. |
| `setPanel(id, visible)` | → `true` when the panel ends up in that state |
| `setSplit(bool, { path?, focus? }?)` | `setPanel("split", …)`. Like the app's own split, the second pane opens at the parent folder and becomes active; `path` opens it at that folder directly (no visible jump; an already-open second pane navigates there), `focus: false` keeps the first pane active → `true` |
| `setTerminalOpen(bool)` | shorthand for `setPanel("terminal", …)` |
| `setViewMode(mode, pane?)` | `details` \| `list` \| `tiles`; view mode is per pane (`pane`: index or pane id, default the active pane) → `true` |
| `setKeybinding(commandId, keys \| null)` | `null` unbinds; keys use the app's syntax (`"Ctrl+Shift+Y"`, chords `"Alt+M B"`) → `true` |
| `resetKeybinding(commandId)`, `resetKeybindings()` | → `true` |
| `run(commandId)` | → `false` for an unknown or unavailable command, else what the command returned |
| `navigate(path, pane?)` | folder: opens it; file: opens its folder and selects it; `"trash://"`: the Recycle Bin. `pane` is the index in `panes` (default: active pane) → `true` on success |
| `readFile(path)` | → the `open-external` payload for that file, or `null` |
| `playVideo(path)` | selects a fixture video with the preview pane shown (the preview has the play control; it does not autoplay) → `false` when the file is not a video |
| `setCustomTheme({ name, dark, v })` | `v` = `[paper, panel, ink, ink2, accent, folder]` as hex → the new theme id (`site-<slug>`), applied and added to the catalog; `null` when invalid |

### Events (`stage.on(event, fn)`, or `"*"` for `(event, data)`)

All events after `ready` fire only on change.

| Event | Data |
|---|---|
| `ready` | `{ catalog, state }` (once: first listing done, commands registered, themes discovered) |
| `settings` | the full settings object |
| `keybindings` | `{ commandId: keys \| null }` for every user override |
| `panels` | `{ sidebar, address, status, preview, windowControls, terminal, split, miller, scm, git }` |
| `navigate` | `{ path, pane }` (`pane` 0 or 1; `path` null when that pane closed) |
| `view` | `{ viewMode, pane }` (`viewMode` null when that pane closed) |
| `select` | `{ path, paths }` (active pane; `path` is the last selected) |
| `fs-change` | `{ op, path, from?, trashCount }`, `op` ∈ `mkdir create write rename move copy symlink trash delete restore purge compress extract` (`purge`: emptied from the Recycle Bin; `from` on rename/move/copy). Every change is reported once, whether it came from the UI, the terminal, or undo/redo |
| `overlay` | `{ open, fullscreen, modal }`: a dialog/palette/Quick Open/Search, or the fullscreen preview |
| `open-external` | `{ path, name, kind, text?, src?, poster?, size, date, rect }`, see below |

### `open-external`

Double-click or Enter on a file, Open in the context menu, Enter in Quick Open and in Search in
Files all call the app's real "open with the system handler" path. The demo answers it by posting
`open-external` and does nothing else. Folders keep navigating; selection and the preview pane are
untouched. `kind` ∈ `markdown text csv image video audio pdf binary` (from the fixture's media,
`type` and extension). `text` is the full text when the file has any (including edits made in the
demo); `src`/`poster` are absolute URLs; `size` is bytes; `date` is ISO 8601. `rect` is the
opened row's `{ x, y, width, height }` in the frame's viewport coordinates (add the iframe's own
offset to animate from it), or `null` when no row for the file is on screen.

The real app has no in-app viewer on double-click: every kind goes to the system handler. Only
double-clicking the **preview pane** opens the app's own fullscreen preview (reported as
`overlay {fullscreen: true}`).

## Catalog

```js
{
  themes:      [{ id, name, description, dark, colors: { background, panel, text, muted, accent, folder } }],
  layouts:     [{ id, name, description, arrangement }],   // setSettings({ layoutTheme: id })
  iconThemes:  [{ id, name, description }],                // setSettings({ iconTheme: id })
  viewModes:   [{ id, command }],                          // setViewMode(id), run(command), or setSettings({ viewMode })
  commands:    [{ id, title, category, keybinding, defaultKeybinding, toggle, hidden }],
  panels:      [{ id, name, setting, command, scope, requires, note }],
  customThemes: true,
}
```

## Panels: what really controls each part

| Mock part | Real panel id | Setting | Command | Notes |
|---|---|---|---|---|
| sidebar | `sidebar` | `showSidebar` | `view.toggleSidebar` (Alt+M B) | |
| address | `address` | `showAddressBar` | `view.toggleAddressBar` (Alt+M D) | |
| status | `status` | `showStatusBar` | `view.toggleStatusBar` (Alt+M U) | |
| preview | `preview` | `showPreviewPane` | `view.togglePreviewPane` (Space) | edge: `previewPanePosition` |
| window controls | `windowControls` | `showWindowControls` | `view.toggleWindowControls` | |
| terminal | `terminal` | — (runtime) | `view.toggleTerminal` (Alt+M T) | needs `enableTerminal` (the demo turns it on) |
| split | `split` | — (runtime) | `view.toggleDualPane` | |
| Miller | `miller` | `millerLayers` (default for panes) | `view.toggleMillerColumns` (Alt+M E) | per pane |
| source control | `scm` | `showScmPanel` (default for panes) | `view.toggleScmPanel` | per pane |
| git graph | `git` | — | `git.showGraph` (Ctrl+Alt+G) | needs `enableGitGraph` (the demo turns it on) and a repository; replaces the pane's file view |
| search | — | — | `general.openQuickOpen` (Ctrl+P), `general.openContentSearch` (Ctrl+Shift+F) | modal, not a panel; reported by `overlay` |
| tabs | — | — | — | **no real toggle**: the tab bar is always shown |

Every other real toggle (hidden files `showHidden` / `view.toggleHidden`, git badges, zoom, …) is a
setting in `settings` and a command in the catalog.

Real-app behaviour a host may notice:

- **Search never looks inside hidden entries.** Quick Open and Search in Files skip every
  dot-named file and folder below the search root, whatever `showHidden` says (the native walkers
  do the same: `search.rs` uses jwalk's `skip_hidden`, `content_search.rs` uses `ignore`'s
  `hidden(true)`, which also honours `.gitignore`; the demo does not model `.gitignore`).
- **Narrow frames scroll the panes, they do not squeeze them.** Each pane keeps a minimum width;
  when sidebar, preview and a split leave less than that, the pane area scrolls horizontally to
  the active pane, so the inactive pane is partly scrolled out of view at its left edge (e.g.
  900 px wide with sidebar, preview and split on). This is the desktop app's own layout, not an
  iframe artefact; give the frame more width or turn a panel off.

## Terminal

The terminal is the real panel over an in-memory shell: `help pwd whoami echo clear history exit cd
ls(-a -A -l) cat(-n) head tail tree(-a -d) find(-name -iname -type) grep(-r -i -n -l -c) mkdir(-p)
touch mv cp(-r) rm(-r -f, to the Recycle Bin) git log [--oneline] [-n N] / status / branch`, with
`;` `&&` `||` `>` `>>`, quotes, globs, history, Tab completion and line editing. No pipes.
Changes go through the same mock filesystem, so panes refresh and `fs-change` fires.

Unlike the old engine, `cd` moves the pane (the app's real *Explorer follows terminal* setting,
`explorerFollowsTerminal`), and navigating the pane `cd`s the shell (`terminalFollowsExplorer`).
Turn either off with `setSettings`.
