# TX engine: an embeddable Tauri Explorer simulation

Classic scripts, no build, work from `file://`. Load order: `explorer.css`, one or more
`content/fs-*.js` (each sets `window.TX_FS.<id>`), then `explorer.js` (defines `window.TX`).
One app per document: a second `TX.mount` destroys the first. Everything is scoped under
`.tx-app`, and every class the engine writes is prefixed `tx-` (`tx-pane`, `tx-c-row`, `tx-sel`, …), as are
sprite ids and keyframes, so host-page CSS cannot collide with it. The theme fade sets `tx-theming` on
`themeRoot`. Exception: the `glyph` SVG in `TX.parts` uses the bare classes `f` (fill), `l` (line) and
`o` (outline) for the host page to style.

```html
<link rel="stylesheet" href="engine/explorer.css">
<div id="demo" style="height:560px"></div>
<script src="content/fs-station.js"></script>
<script src="engine/explorer.js"></script>
<script>
  const app = TX.mount(document.getElementById("demo"), {
    fs: TX_FS.station, user: "ines", themeRoot: document.getElementById("demo"),
    setup: { parts: ["tabs", "address", "sidebar", "status"], theme: "nord", view: "list" },
  });
  app.on("setup", s => history.replaceState(null, "", "?setup=" + TX.encodeSetup(s)));
  document.querySelector("#show-terminal").onclick = () => app.togglePart("terminal");
</script>
```

The container needs a size; the app fills it (100% × 100%) and re-lays out in CSS on resize.

## `TX.mount(container, opts)` options
- `fs` – a `TX_FS` object (default `TX_FS.default`).
- `user` – user id; default the first user. Its `setup` applies, then `opts.setup` on top.
- `setup` – object, `TX.encodeSetup` string, or JSON string.
- `themeRoot` – element that receives the `--tx-*` colour tokens and `data-tx-scheme="light|dark"`
  (default `<html>`, so the whole page is dressed; pass the container to keep the host page untouched).
- `assetBase` – prefix for engine-generated images (plugin results); default `"../peel-mock/assets/"`.
- `tabs` – array of start paths for the tabs (default: start path plus two picked folders).
- `handoff` – `true`: opening a file (double-click, Enter, Open in the menu) only selects it and emits
  `open {how: "open", handoff: true}`; the host plays the system's default app. No preview, film viewer or toast.

## Setup `{ parts, theme, layout, icons, view, path, compact?, keys?, hidden? }`
- `parts`: ids from `TX.parts`. Panels: `tabs address sidebar miller preview split terminal status`.
  Features: `views peek search git plugin palette themes hotkeys`. Unknown ids are ignored.
- `theme`: id from `TX.themes`, or a custom `{ name, dark, v: [paper, panel, ink, ink2, accent, folder] }`.
- `layout`: `default floating-islands soft-cards hairline-ledger`. `icons`: `material classic minimal catppuccin default`.
- `compact`: `true` for the app's Compact density (#1878): shorter bars and rows on any layout. The retired
  `layout: "compact"` loads as `default` with `compact: true`. A complete setup without it turns it off.
- `view`: `details list tiles`. `path`: absolute or `~/…`; a file path selects that file.
- `keys`: `{ commandId: "Ctrl+K" | "Alt+M B" (chord) | null (unbound) }` – only overrides are stored.
- A setup containing `parts` is complete: missing parts turn off, keys and hidden reset to defaults.
  One without `parts` is a patch. Ids are lowercase and matched exactly.
- `TX.encodeSetup(s)` → base64url string; `TX.decodeSetup(x)` → object or `null` (never throws).

No gating: invoking a feature whose part is off turns the part on (Ctrl+P adds `search`,
`open` in the shell adds `preview`, opening (double-click or Enter) a text or image file adds `preview`
and selects it, opening the git graph adds `git`, …). Parts animate in/out
with CSS transitions; `prefers-reduced-motion` cuts them to ~0.

- Split: when `split` turns on, the second pane opens on the main pane's folder with its view and
  sort; it keeps its own place while it stays on. Switching user resets it.
- Details headers Name / Size / Modified are buttons (`data-sort`, `aria-sort`): a click sorts by that
  column, a second click reverses it. Size and Modified start largest / newest first; folders stay first.

## App API (returned by `mount`; also `TX.app`)
| member | does |
|---|---|
| `el` | the `.tx-app` element |
| `setSetup(s, {animate=true})` / `getSetup()` | apply / read the setup |
| `togglePart(id)` / `setPart(id, on)` / `hasPart(id)` / `parts()` | part control |
| `setUser(id, {animate})` / `user()` / `users()` | switch user (applies that user's setup, goes home) |
| `navigate(path, {pane:"main"\|"split"})` / `path()` / `selection()` | pane location |
| `openPalette()` / `openQuickOpen(q?)` / `openSearch(q?)` | overlays |
| `shell(line)` | run a line in the terminal (adds the terminal part) |
| `registerCommand({id, title, keys?, run, cat?, global?})` | adds to the palette + keymap; `run(app)` |
| `run(id)` / `commands()` | run / list commands |
| `on(ev, fn)` / `off(ev, fn)` | events below |
| `openKeys(commandId?)` | the Keyboard Shortcuts dialog, with that command selected (Enter records a new key) |
| `read(path)` | a file's text, or `null` (folders, binaries, missing) |
| `stat(path)` | `{path, name, dir, kind, text, src, poster, size, date, px, duration}` for a file (`src` is the picture or the film), `{path, name, dir: true, date}` for a folder, or `null` |
| `list(path)` | `[{name, path, dir, kind, image, video, repo, hidden}]` for a folder (hidden included), or `null` |
| `repoRoot(path)` / `binCount()` | the repository containing a path (or `null`) / items in the Recycle Bin |
| `playFilm(path)` / `closeFilm()` / `filmOpen()` | open the film viewer on a video (false if not one) / close it / the open film's path or `null` |
| `focus()` / `toast(text)` / `destroy()` | misc |

Events: `navigate {path, pane}`, `open {path, how: "select"|"open", pane, handoff?}`, `setup` (full setup, coalesced; not fired by
plain navigation), `command {id, via}`, `search {kind, query, count}`, `fs-change {op, path, to}`
(`rename trash restore copy move add write`), `user {id, name, home}`, `film {path, open}` (the viewer
opened or closed; a host page can dim itself around it).
`TX.themes / layouts / iconsets / parts` are arrays of `{id, name, …}` for building pickers
(themes carry `swatch`; parts carry `kind`, `name`, `short`, `desc`, `glyph` SVG).

## Keys
v3 defaults (Ctrl+P, Ctrl+Shift+P, Ctrl+Shift+F, Ctrl+L, F2, Delete, Ctrl+Z, Alt+M chords, …) plus
Ctrl+H hidden files, Ctrl+PageUp/PageDown tabs, `Alt+M T` terminal. Keys act when focus is in the
app or on `<body>`; on a bare page only modified keys are taken. Browsers may keep Ctrl+PageUp/Down.
The terminal owns every key except Quick Open, Palette, prev/next tab and the terminal toggle.

## Terminal
`help pwd whoami echo(> >>) clear history exit cd(-) ls(-a -A -l) cat(-n) head tail tree(-a -d)
find grep(-r -i -n -l -c) mkdir(-p -v) touch mv cp(-r) rm(-r -f -d -v → Recycle Bin, undoable)
open git(log [--oneline] [-n N], status, branch, show)`; `;` and `&&`; Tab completion, history,
Ctrl+C/L/U/A/E. The pane drives the terminal's cwd; `cd` never moves the pane, `open` does.

## Filesystem format: `window.TX_FS.<id> = { title?, users, tree, trash?, repos? }`
- `users: [{ id, name, home, blurb?, bookmarks?: [paths], setup }]`.
- `tree`: root `{ kids: [...] }`. Node: `{ name, kind?: "dir"|"file", kids?, text?, src?, px?: "WxH",
  size?: number(bytes)|"2 KB", date?, type? }`. `kids` ⇒ folder. `type` overrides the inferred kind
  (`md txt pdf csv code svelte audio app img video file`); `src` ⇒ image, or a film when `type: "video"`
  or `src` ends `.mp4 .webm .mov .m4v`. Size defaults from `text`.
  `src` is relative to the **page** (pages in `overhaul/` use `assets-…/x.webp`, `../peel-mock/assets/x.webp`).
- Films: `{ name, type: "video", src, poster?, duration?: "4:12", px? }`. The poster is the thumbnail in
  Tiles (with a play mark) and the icon elsewhere; without a poster, a film glyph. The preview pane shows a
  `<video controls playsinline preload="metadata" poster>` that never autoplays and keeps its playback
  position across re-renders; it pauses when the selection changes. Opening a film (double-click, Enter,
  `playFilm`) shows the viewer over the whole app window and plays it with sound (it follows a user
  gesture; if the browser still refuses sound it plays muted with controls to unmute). In the viewer:
  Esc or × closes, Space or K pauses, ←/→ seek 5 s, F or the corner control asks for real full screen
  (never forced). Closing pauses and unloads the film and exits full screen. Each media URL (film and
  poster) is requested once: a missing file costs one failed request, then shows the poster or the plain
  glyph, never an error loop. Reduced motion removes the viewer's fade, not playback.
- Names starting with `.` are hidden until Toggle Hidden Files (Ctrl+H). `date` may be ISO
  (`2026-10-11T07:04:00`, shown as "Oct 11 2026, 07:04") or free text.
- `trash: [{ node, from: "/original/dir", deleted }]` → shown in the sidebar Recycle Bin, restorable.
- `repos: { "/abs/repo/path": { branch, changes?: [{path, status, base?, staged?}], commits: [...] } }`.
  `changes` are the uncommitted files: `status` `"M"`, `"A"`, `"D"` or `"??"` (untracked), `base` the
  file's text as of the last commit (the app demo diffs the working file against it; without it the
  diff shows no lines changed), `staged: true` if it is already in the index. Commits are
  newest first: `{ hash, msg ("subject\n\nbody"), author, date, parents: [hash…], refs?: [...],
  files: [{ path, status: "A"|"M"|"D"|"R", diff?: unified-diff text }] }`. Merges have 2 parents;
  files without `diff` list without one. The repo folder gets a git badge; the graph opens from it.
  Branches: each `refs` entry decorates its commit (`"HEAD -> main"`, `"main"`, `"origin/main"`,
  `"tag: v1"`); a plain name is a local branch, so a side branch is a ref on its tip. A merged branch's
  tip is reachable from `branch` through a 2-parent commit; an open one is a tip nothing else reaches.
  List commits in git log's date order: newest first, every child before its parents (the real app's
  graph lays lanes out in the order given). The app demo (`bridge/`) reads the same format.

## Tokens (override on `themeRoot` or `.tx-app`)
`--tx-paper --tx-app --tx-app-side --tx-app-line --tx-app-sel --tx-ink --tx-ink-2 --tx-ink-3
--tx-teal --tx-folder --tx-term-bg --tx-sans --tx-mono --tx-display --tx-radius --tx-gap --tx-r`.
Themes write these inline on `themeRoot`; `data-layout` / `data-icons` sit on `.tx-app`.

## `base.html` (reference harness)
`base.html?fs=default|station|archive&user=…&setup=…&parts=a,b&theme=…&layout=…&icons=…&view=…&path=…`
Params after `setup` override it. `window.app` is the mounted app.
