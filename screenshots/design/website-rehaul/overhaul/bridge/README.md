# TXBridge: the real app on the site

The site demo is the real Tauri Explorer frontend, built with `VITE_SITE_DEMO=1`, running on the
browser mock backend. It is fed a `TX_FS` fixture by the page that embeds it. Everything you see
(listings, previews, Quick Open, Search in Files, the Recycle Bin, the terminal, the git graph,
themes, layouts, keybindings) is the shipping code.

```sh
bun run build:demo     # → build-demo/ (gitignored), base path /app/; safe to run under open pages (below)
bun run demo:serve     # http://127.0.0.1:1455/real.html?fs=station  (PORT=… overrides)
```

`demo:serve` serves `overhaul/` at `/`, falls back to `website-rehaul/` (so `../peel-mock/assets/`
resolves) and serves the build at `/app/`. A deployment must do the same: **the app has to be
same-origin with the host page** (both sides check `event.origin`).

`real.html?fs=station|expedition|archive|default` is the harness: a full-viewport demo, a strip of
buttons for every request, and a live event log. An unknown `fs` boots the built-in fixtures.

A rebuild does not break a page that is already open. Each build has new content-hashed chunk
names, and an open page loads its lazy chunks (List and Tiles views, the git graph, dialogs) by the
names of the build it booted from; replacing `build-demo/` in place used to make such a page show
"Unable to load List view" or "Could not load Git history". `build:demo` (`scripts/build-demo.mjs`)
builds into `build-demo.next/`, carries the previous build's `_app/immutable/` files over for 7 days,
and then swaps the directory in. **A deployment needs the same**: keep the previous release's
`_app/immutable/` files servable for as long as a visitor may keep the page open.

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
| `getState()` | → `{ path, panes: [{index, paneId, path, viewMode, selection, active}], settings, theme, panels, keybindings, media, trashCount, repos, appearance }` (`trashCount`: items in the Recycle Bin; `repos`: the fixture's git repositories, `[{ path, branch, changes }]`, where the git graph has something to show, with `changes` the number of files the Source Control panel lists now (staged, modified and untracked; a badge count); `appearance`: as the event) |
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
| `focusApp()` | gives the frame keyboard focus again (after the host re-shows a closed or minimized window): the element that had focus keeps it, else the active pane's selected row or file list → `true` when the frame has focus |
| `closeOverlays()` | closes Quick Open, the palettes, Search in Files and every other dialog, as Escape would (a dialog guarding unsaved input, such as a rename in progress, stays open) → `true` when none is open afterwards |
| `setTouchLayout(on)` | the host's phone layout. `true`: on a touch screen a single tap on a file or folder row opens it, as a double-click does (folders navigate, files reach `open-external`; the tap still selects first), and the app's text fields are at least 16 px, so a phone never zooms the page when one takes focus (iOS zooms the top page for a smaller field, even in this frame; pinch zoom is untouched), and file rows draw no keyboard-cursor ring (the app still moves its cursor; with no keyboard the ring would read as a stray selection). Only touch and pen taps count: a press that scrolls, moves 10 px or more, is held past 500 ms (the context menu) or is a mouse click is not one, and a tap on a control inside a row (a peek caret, the rename box) keeps its own behaviour. Default off; the app's double-click and Enter keep working either way → `true`, `false` for a non-boolean |

### Events (`stage.on(event, fn)`, or `"*"` for `(event, data)`)

All events after `ready` fire only on change.

| Event | Data |
|---|---|
| `ready` | `{ catalog, state, boot }` (once: first listing done, commands registered, themes discovered) |
| `appearance` | `{ colorScheme, material }`: the app document's computed `color-scheme` and the material behind it (`"acrylic"` while Translucency is on, else `null`). Unlike the others it is sent from boot, before `ready`. TXBridge copies `colorScheme` onto the iframe element itself; see Translucency |
| `settings` | the full settings object |
| `keybindings` | `{ commandId: keys \| null }` for every user override |
| `panels` | `{ sidebar, address, status, preview, windowControls, terminal, split, miller, scm, git }` |
| `navigate` | `{ path, pane }` (`pane` 0 or 1; `path` null when that pane closed) |
| `view` | `{ viewMode, pane }` (`viewMode` null when that pane closed) |
| `select` | `{ path, paths }` (active pane; `path` is the last selected) |
| `fs-change` | `{ op, path, from?, trashCount }`, `op` ∈ `mkdir create write rename move copy symlink trash delete restore purge compress extract` (`purge`: emptied from the Recycle Bin; `from` on rename/move/copy). Every change is reported once, whether it came from the UI, the terminal, or undo/redo |
| `overlay` | `{ open, fullscreen, modal, kind }`: a dialog/palette/Quick Open/Search, or the fullscreen preview. `kind` names it: `"quick-open"`, `"command-palette"`, `"content-search"`, `"theme-picker"`, `"keybindings"`, `"settings"`, or `null` (another dialog, the fullscreen preview, or none) |
| `open-external` | `{ path, name, kind, text?, src?, poster?, size, date, rect }`, see below |
| `window-control` | `{ action: "minimize" \| "maximize" \| "close" }`: one of the title bar's window buttons (`showWindowControls`) was pressed. The app does nothing else (the tab, panes and state stay as they are); the host decides what the window does, and can call `focusApp()` when it shows it again |
| `window-drag` | `{ phase: "start" \| "move" \| "end", screenX, screenY, clientX, clientY }`: the title bar is being dragged, as a native window is moved by it (see Moving the window) |

### Moving the window

The demo has no window of its own, so where the desktop app's title bar calls `startDragging()`, the demo reports
the drag and the host moves whatever stands in for the window:

- **What drags.** The title bar's drag region, as on the desktop: its empty space (beside and after the tabs),
  never a tab, a button or an input (`titlebar.startsWindowDrag`). A press becomes a drag after 4 px of travel, so
  a click never moves the window. One pointer at a time; mouse, pen and touch alike (the bar is `touch-action:
  none` in the demo, so a swipe drags instead of panning).
- **Events.** `start` carries the press point, then a `move` per pointer move, then `end` on release (or, after
  a cancelled pointer, at the last point). The app captures the pointer, so the moves keep coming while the frame
  moves away under it.
- **Coordinates.** Move the window by the change in `screenX`/`screenY` since `start`: they do not depend on where
  the frame is, whereas the frame-relative `clientX`/`clientY` change as the window moves (the host's motion would
  feed back into the drag). `clientX`/`clientY` place the pointer on the host page at `start` (add the iframe's
  offset), e.g. to keep it at the same place along the title bar when a maximised window is pulled off the top.
- **Double-click** on the drag region is the desktop's maximise/restore: it arrives as `window-control
  { action: "maximize" }`, the same event as the maximise button, so a host that toggles maximise on that event
  gets both.
- Resizing is the host's alone (the frame cannot see its own edges): the Workshop puts invisible grips round the
  window (`desktop.js` `TXDesk.frame`, geometry in `desk-move.js`).

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

## Translucency (a wallpaper behind the app)

The app's own Translucency setting works in the demo. The frame reports a window material
(`"acrylic"`, the Windows one), so the Settings rows **Translucency** and **Translucency Opacity**
and the command `setting.toggle.translucency` ("Toggle Translucency") appear, and:

```js
stage.setSettings({ translucency: true });          // boolean, default false
stage.setSettings({ translucencyOpacity: 40 });      // 20–100 (%), default 55: how much of the backdrop the panels hide
```

With it on, the app's material styles apply exactly as on a native translucent window (`[data-material]`,
`[data-native-backdrop]`): the document and body are transparent and every surface is tinted at the
Opacity's coverage. Floating Islands gives the look of `screenshots/feat/tab-owns-window/islands-dark-material.png`;
other layouts tint the whole window. Unlike a native window the setting can be switched at any time.

What the host does:

- Put the wallpaper **behind** the iframe and leave the iframe and its wrapper without a background.
- **Blur is the host's job**: give the iframe's wrapper `backdrop-filter: blur(30px) saturate(1.5)`
  (or similar). The native material is a blurred wallpaper; a `backdrop-filter` inside the frame
  cannot see the host page, so the app cannot blur it. Without the filter the wallpaper shows through sharp.
- Keep the iframe element's `color-scheme` equal to the app's. A browser paints an opaque canvas
  behind a frame whose color scheme differs from its element's (a dark theme on a light page shows a
  black window). **TXBridge does this for you** from the `appearance` event; a host that talks to the
  frame without TXBridge must set `iframe.style.colorScheme = appearance.colorScheme` itself.
- `prefers-reduced-transparency: reduce` makes the surfaces solid, as in the desktop app.

## Catalog

```js
{
  themes:      [{ id, name, description, dark, colors: { background, panel, text, muted, accent, folder } }],
  layouts:     [{ id, name, description, arrangement }],   // setSettings({ layoutTheme: id }); density: setSettings({ compact: true })
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
| source control | `scm` | `showScmPanel` (default for panes) | `view.toggleScmPanel` | per pane; works inside a fixture repository (see below), shows "Not a git repository" elsewhere |
| git graph | `git` | — | `git.showGraph` (Ctrl+Alt+G) | needs `enableGitGraph` (the demo turns it on) and a repository; replaces the pane's file view |
| search | — | — | `general.openQuickOpen` (Ctrl+P), `general.openContentSearch` (Ctrl+Shift+F) | modal, not a panel; reported by `overlay` |
| tabs | — | — | — | **no real toggle**: the tab bar is always shown |

Every other real toggle (hidden files `showHidden` / `view.toggleHidden`, Compact density `compact` /
`view.toggleCompact` on any layout (#1878; the old `layoutTheme: "compact"` loads as Default + `compact: true`),
git badges, zoom, …) is a
setting in `settings` and a command in the catalog.

Real-app behaviour a host may notice:

- **The git graph needs a repository.** `git.showGraph` (and `setPanel("git", true)`) opens the
  graph of the repository containing the active pane's folder. Outside one it behaves as the desktop
  app does: the command runs, shows the toast "Not inside a git repository" and leaves the pane as it
  was (`run` → `true`, `setPanel` → `false`). `getState().repos` lists the fixture's repositories, so
  `navigate(repos[0].path)` first. The demo has no Upscale plugin (it needs a fal.ai account).

- **Source control works in the fixture repositories, in memory.** Inside a repository from the
  fixture's `repos`, the Source Control panel lists the fixture's `changes` plus whatever the
  visitor does there: a file created, edited, renamed or deleted (in the app or the terminal) shows
  as untracked, modified or deleted. Stage and unstage (files or single hunks) move entries between
  the lists, clicking a change shows its diff (HEAD vs index vs working tree), Discard restores the
  file from the last commit (or removes an untracked one), Ignore appends to `.gitignore`, and
  Commit records a commit on the current branch that heads the git graph and the terminal's
  `git log` and empties the staged list. A change whose fixture entry has no `base` text lists as
  modified, but its diff shows the file unchanged and Discard keeps it as it is. Everything resets
  on reload. Branch switching, merging, pull/push, stash and "Move to .archive" are refused with
  the toast "This demo repository is read-only". Outside a repository the panel shows the app's
  ordinary "Not a git repository" state. Terminal: `git status` (staged, unstaged, untracked),
  `git log`, `git branch`.

- **Search never looks inside hidden entries.** Quick Open and Search in Files skip every
  dot-named file and folder below the search root, whatever `showHidden` says (the native walkers
  do the same: `search.rs` uses jwalk's `skip_hidden`, `content_search.rs` uses `ignore`'s
  `hidden(true)`, which also honours `.gitignore`; the demo's search does not model `.gitignore`).
- **Narrow frames scroll the panes, they do not squeeze them.** Each pane keeps a minimum width;
  when sidebar, preview and a split leave less than that, the pane area scrolls horizontally to
  the active pane, so the inactive pane is partly scrolled out of view at its left edge (e.g.
  900 px wide with sidebar, preview and split on). This is the desktop app's own layout, not an
  iframe artefact; give the frame more width or turn a panel off.

## Terminal

The terminal is the real panel over an in-memory shell: `help pwd whoami echo clear history exit cd
ls(-a -A -l) cat(-n) head tail tree(-a -d) find(-name -iname -type) grep(-r -i -n -l -c) mkdir(-p)
touch mv cp(-r) rm(-r -f, to the Recycle Bin) git log [--oneline] [--all] [-n N] / status / branch`, with
`;` `&&` `||` `>` `>>`, quotes, globs, history, Tab completion and line editing. No pipes.
Changes go through the same mock filesystem, so panes refresh and `fs-change` fires.
`git log` lists what git would: the history of HEAD (a merged branch's commits included, a branch
never merged only with `--all`); `git branch` lists every branch in the fixture's `refs`.

Unlike the old engine, `cd` moves the pane (the app's real *Explorer follows terminal* setting,
`explorerFollowsTerminal`), and navigating the pane `cd`s the shell (`terminalFollowsExplorer`).
Turn either off with `setSettings`.
