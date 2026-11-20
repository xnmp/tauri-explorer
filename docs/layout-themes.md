# Layout themes

A **layout theme** controls the structure of the window: spacing between
panels, borders, corner radii, panel surfaces, chrome density and the Details
row height. It is independent of the **colour theme** (Settings → Appearance →
Color Theme), which supplies the palette. Any layout can be combined with any
colour theme.

Four layouts are built in:

| Layout | Id | What it does |
| --- | --- | --- |
| Default | `default` | The flat, edge-to-edge layout. The active tab owns the window: tab, sidebar, toolbar, list and status bar are one surface, only the strip round the tabs is shaded, and one outline runs round the tab and along the strip's base (#1856). A rule a step darker than that outline separates the sidebar from the file pane (#1879). Ships in the startup CSS. |
| Floating Islands | `floating-islands` | Rounded panels floating over the window backdrop (#277, #434). Ships in the startup CSS. |
| Hairline Ledger | `hairline-ledger` | Square, dense panels ruled by 1px hairlines, all chrome in its monospace (file names and previewed documents keep the theme's face, #1879) and an inverted row selection (tiles are ruled instead). The active tab owns the window as in Default, square and without feet: tab, sidebar, toolbar and list share the content surface, the tab strip is paper, and one hairline runs round the tab and along the strip's base (#1871). Loaded on demand. |
| Soft Cards | `soft-cards` | Opaque 8px-rounded cards with 1px borders and no shadows on a slightly darker backdrop (a cool light grey on light themes). Every gap is 6px, the tab included; split panes, the preview, terminal and source-control panel become separate cards, and selected rows sit inset inside them (#1548, #1854). Loaded on demand. |

Choose one in **Settings → Appearance → Layout**, with **Switch Layout...** in the
command palette (live preview while you move through the list), or with
**Toggle Floating Islands Layout**.

**Compact** (Settings → Appearance → Compact, or **Toggle Compact Mode** in
the command palette) is a density, not a layout (#1878): it tightens
whichever layout is applied, built-in or your own. The title bar, tabs,
toolbar, status bar, column header and sidebar entries get shorter, Details
rows drop to 22px and List rows to a 26px slot, and Tiles keep about three
quarters of their gaps and padding (the tile, icon and name keep their size).
On Default that is 30px title bar, 26px tabs, 32px toolbar and 20px status
bar, the sizes of the former Compact layout (#1548). See
[Compact density](#compact-density) for what a layout can tune.

## Installing a custom layout

1. Settings → Appearance → Layout → **Open folder**. This creates and
   opens `<config>/layouts/`:
   - Linux: `~/.config/tauri-explorer/layouts/`
   - macOS: `~/Library/Application Support/tauri-explorer/layouts/`
   - Windows: `%APPDATA%\tauri-explorer\layouts\`
2. Save a `.css` file there, for example
   [`docs/examples/layouts/roomy-cards.css`](examples/layouts/roomy-cards.css).
3. Pick it in the Layout selector. No rebuild or restart is needed.

Saving the file re-applies it in every open window. Adding or removing files
updates the selector the next time it opens.

File rules: a plain file name ending in lowercase `.css` (no sub-folders, no leading
dot), UTF-8 text, at most 512 KiB. The file name is the layout's id and is what
settings store, so renaming a file deselects it.

## Metadata

An optional leading comment names the layout:

```css
/*
 * @name Roomy Cards
 * @description Roomy rounded cards on a quiet backdrop.
 * @extends soft-cards
 */
```

| Key | Meaning |
| --- | --- |
| `@name` | Name shown in the selector. Defaults to the file name in title case (`dense-grid.css` → "Dense Grid"). |
| `@description` | Shown in the layout picker. |
| `@extends` | Built-in base: `default` (the default), `floating-islands`, `hairline-ledger` or `soft-cards`. The base's stylesheet and structural arrangement apply first and your file cascades on top. An unknown value means `default`, and so does `compact`, the former Compact layout (#1878): its surfaces were Default's, and its sizes are now the Compact setting. |

`@extends floating-islands` also takes the Floating Islands *arrangement*:
with the sidebar hidden, Miller columns move into their own island, and split
dividers widen into 8px gaps.

The comment must be the first thing in the file and must be closed; a file
whose leading comment never closes is rejected rather than half-applied.

## Variables

The application reads these custom properties. Set them on `:root`. Unset
variables keep the Default value shown.

| Variable | Default | Applies to |
| --- | --- | --- |
| `--layout-gap` | `0px` | Gap between sidebar, panes, preview and Miller island. |
| `--layout-inset` | `0px` | Padding around the panel area (any `padding` value). |
| `--layout-radius` | `0px` | Corner radius of the sidebar, pane area, preview island. |
| `--layout-border` | `none` | Border of those panels (any `border` value). |
| `--layout-shadow` | `none` | Shadow of those panels (any `box-shadow` value). |
| `--layout-surface` | theme card colour | Background of the file panes and preview. |
| `--layout-chrome-surface` | theme chrome colours | Background of title bar, sidebar, toolbar, column header and status bar. |
| `--layout-app-surface` | native-material tint | Window body (`[data-region="app"]`) under native material. Unset, the page paints the theme tint (on macOS, the theme base at 15% on light themes and 55% on dark ones). Floating Islands sets its own (see below). |
| `--layout-hairline` | `var(--divider)` | Rule colour between chrome regions. |
| `--layout-row-height` | `32px` | Details row height, in `px`, clamped to 20–64. Virtual scrolling and marquee selection follow it. |
| `--layout-row-inset` | `0px` | Horizontal inset of every Details row inside the file list. The column header's text moves in by the same amount, so columns stay aligned; a selection or focus outline then never touches the panel edge. |
| `--layout-compact-titlebar-height` | `30px` | Title bar height at compact density. |
| `--layout-compact-tab-height` | `26px` | Tab (and window control) height at compact density. |
| `--layout-compact-toolbar-height` | `32px` | Toolbar height at compact density. |
| `--layout-compact-status-bar-height` | `20px` | Status bar height at compact density. |
| `--layout-compact-row-height` | `22px` | Details row height at compact density; it replaces `--layout-row-height` while Compact is on. |

Colour theme variables (`--text-primary`, `--background-card`, `--accent`,
`--surface-stroke`, `--divider`, ...) are available for building colours, which
keeps a layout working with every palette.

## Hooks

Elements a layout may style carry a stable `data-region` attribute. Class
names are internal and change without notice; `data-region` names do not.

| `data-region` | Element | State attributes |
| --- | --- | --- |
| `backdrop` | Decorative background layer behind the app | |
| `app` | The whole window surface | |
| `titlebar` | Title bar containing the tab strip | Floating Islands: `data-tab-hole="left right"` (the active tab's opening, CSS px) |
| `tab-strip` | Window tab strip | |
| `tab` | One window tab | `aria-selected="true"` on the active tab |
| `tab-fillet` | Curves joining the active tab to the content | `data-side="left\|right"` |
| `tab-key-shadow` | Layouts whose active tab owns the window (Floating Islands, Default, Hairline Ledger): inline SVG under the tab strip holding the strip shade (with the active tab's hole and the shade pockets outside the surface's rounded top corners) and the tab's key shadow | |
| `tab-edge` | Same layouts: inline SVG outline, the active tab plus the top edge and corners of its surface (#1785) | |
| `main` | Area below the title bar | |
| `sidebar` | Sidebar container (outer box) | |
| `sidebar-body` | Sidebar painted body | |
| `sidebar-section-header` | Section headings (Quick Access, Drives, ...) | |
| `sidebar-item` | One sidebar entry | |
| `sidebar-icon` / `sidebar-label` | Its icon and label | |
| `miller-island` | Miller columns hoisted into their own panel | |
| `miller` | Miller columns strip | |
| `panes` | The pane area | `data-split` when it holds more than one pane |
| `pane` | One explorer pane | `data-active` on the focused pane of a split |
| `split-divider` | Divider between split panes | `aria-orientation`; `data-dragging` while it is being dragged |
| `split-grip` | The grip drawn on a split divider | |
| `toolbar` | Pane navigation bar | |
| `address-bar` | Breadcrumb / path field | |
| `file-list` | File list of any view | `data-view="details\|list\|tiles"` |
| `column-header` | Details column header | |
| `row` | One entry, in every view (scope with `[data-view]` on `file-list`) | `aria-selected="true"` when selected |
| `entry-name` | An entry's file name, in every view, and its rename field (#1879) | |
| `[data-cell]` | Details cells: `name`, `date`, `type`, `size`, `length`, `resolution` | |
| `preview` | Preview panel wrapper | |
| `preview-body` | Preview panel content | `data-fullscreen` while fullscreen |
| `scm` | Source control panel | `data-island` when floating |
| `terminal` | Terminal panel (counter-zoomed, #419: scale lengths by `var(--app-zoom)`) | |
| `status-bar` | Status bar | |

Root (`<html>`) attributes describe the window and can scope rules:

| Attribute | Meaning |
| --- | --- |
| `data-layout` | Applied layout id (`default` after a fallback). |
| `data-layout-base` | Applied built-in base. |
| `data-density` | `compact` while the Compact setting is on (#1878); absent otherwise. |
| `data-theme` | Active colour theme id. |
| `data-native-backdrop` | A native window material is behind this window (the Translucency setting). The body is transparent; paint opaque surfaces only where you want them. |
| `data-material` | Which material: `vibrancy` (macOS), `acrylic` (Windows 11 22H2+) or `mica` (earlier Windows 11). The page tints the window body with the theme base. |
| `data-preview-fullscreen` | A preview is fullscreen. |

Before #1757 these were platform-specific attributes. A user layout that
targeted them needs updating:
- `data-macos-material` and `data-transparent-window` are now `[data-material="vibrancy"]`.
- `data-win-backdrop` is now `[data-material="acrylic"]` or `[data-material="mica"]`.
- `[data-native-backdrop]` still matches all of them.

### Floating Islands surfaces

Under a window material (any `data-material`), Floating Islands reads a
small theme contract.
Set these on `:root` in a colour theme; unset, the defaults apply.

| Variable | Default | Meaning |
| --- | --- | --- |
| `--island-surface` | light: `--vibrancy-island-card`, else `--background-card`; dark: `--background-solid` lifted 10% toward white | Panel colour of every island. |
| `--island-body-coverage` / `-dark` | `0.15` / `0.3` | Share of the material the window body hides. |
| `--island-coverage` / `-dark` | `0.983` / `0.545` | Total share a content island (panes, preview, Miller) hides, body included. |
| `--island-structural-coverage` / `-dark` | `0.762` / `0.48` | Total share the sidebar hides, body included. |

The "Translucency Opacity" setting (Appearance, shown while Translucency is
on, default 55%) overrides all six values inline on the root, so it beats a
theme's own; `domain/vibrancy-opacity.ts` maps the slider and its default
reproduces the table above. It also sets `--material-window-coverage` /
`-dark` (default `0.15` / `0.55`), the share of the material the window tint
of other layouts hides. The variables are removed when there is no material.

Alphas compound over the body, so an island's own alpha is derived:
`island alpha = 1 - (1 - coverage) / (1 - body coverage)`. The light defaults
reproduce the earlier alphas exactly. The window body is the theme base
nudged 6% toward the accent; a theme's `--vibrancy-tint` or a layout's
`--layout-app-surface` still wins. Under `prefers-reduced-transparency`
every surface is opaque.

The active tab owns the whole window below the strip (#1785): the tab is a
hole in the strip shade through which the window body, its surface, shows.
That surface runs edge to edge under every island and the status bar, with
rounded top corners (`--layout-radius`) where the shade wraps round it, and
the only outline is the tab plus the surface's top edge. The rest of the
strip is shaded (35% light, 50% dark). Islands keep their own outlines and
sit `--layout-gap` below the strip.
Islands carry no `backdrop-filter`: it made each island the containing block
of fixed overlays, so menus opened offset, and the webview cannot sample the
native material anyway. Context menus and modal cards are opaque.

### Default surfaces

Default (#1856) and Hairline Ledger (#1871) draw the same tab seam as Floating Islands, flat: square
surface corners, no tab shadow, and the strip shaded over the surface
colour. The title bar, sidebar and toolbar take `--layout-chrome-surface`
when a layout sets it, else the content pane's own surface; the column
header and status bar keep their opaque chrome tones (rows scroll under the
header, and the status bar's warning text is tuned against its tone). The
title bar's bottom row lies below the strip's base and carries the
outline's base, so the whole outline stays inside the bar and the bar never
stacks over menus and dialogs in the window. A layout that extends Default and rounds its panels with
`--layout-radius` keeps the tab's surface square unless it also sets
`--islands-surface-radius`.

Hairline Ledger colours the seam in its own stylesheet: the strip is its
paper (`--layout-chrome-surface`), the title bar, sidebar and toolbar take
its content surface (`--layout-surface`), the outline is `--layout-hairline`,
and the tab has no feet (its `tab-fillet` is not displayed, so the marks
read a zero fillet and draw square corners).

### Compact density

The Compact setting (#1878) puts `data-density="compact"` on the root and
injects one more stylesheet (`src/lib/layouts/compact-density.css`) after
every layout stylesheet, your file included. Its rules are scoped to
`:root[data-density="compact"]`, so they outrank a layout's `:root [...]`
rule on specificity and a base-scoped one on order. It changes only the
vertical dimension (heights, vertical padding, text size); horizontal
padding, radii and colours stay your layout's.

A layout honours Compact by setting no fixed size that the density sheet
does not override, and tunes its compact sizes with the
`--layout-compact-*` variables above rather than by fighting the sheet:
Floating Islands sets `--layout-compact-status-bar-height: 16px` (its status
bar is already 18px) and Soft Cards `--layout-compact-tab-height: 24px` (its
tab stays 6px below the top of the 30px bar). To restyle something else at
compact density, scope a rule to `:root[data-density="compact"]` and give it
one more attribute or class than the density rule (for example
`:root[data-density="compact"][data-layout] [data-region="toolbar"]`).
`--layout-row-height` set on `:root` is ignored while Compact is on; set
`--layout-compact-row-height` instead.

The tab seam (`tab-key-shadow`, `tab-edge`) measures the rendered tab, so
it follows compact heights with no extra rules. Tiles spacing is not CSS:
the virtualized grid computes it (`domain/tile-layout.ts`).

### Native window material

Native material is a separate window capability, never part of a layout. A
layout must look right both with and without it: scope translucent surfaces
to `:root[data-native-backdrop]` and keep them opaque otherwise.

The one **Translucency** setting turns it on wherever the platform has a
material (#1757); the native side picks which (`src-tauri/src/translucency.rs`)
and publishes it to every page. A window's material is fixed when the window
is created, so the setting reaches new windows and the next launch.

## Precedence

1. Application styles (component CSS, colour theme).
2. Floating Islands and Default rules, scoped to `:root[data-layout-base="floating-islands"]` and `:root[data-layout-base="default"]`.
3. The base stylesheet of a lazily loaded built-in (Hairline Ledger, Soft Cards).
4. Your layout file.
5. The compact density stylesheet, while the Compact setting is on (#1878).

Layout stylesheets are inserted after all application CSS, so a rule of equal
specificity wins. Component rules are usually a single class, which an
attribute selector merely ties; prefix rules with `:root` (as in
`:root [data-region="row"]`) to outrank them reliably. Avoid `!important`
except to override a rule the application keys on state you cannot match.

The colour theme is applied independently and is never reset by a layout
change, and vice versa.

## Minimal example

```css
/* @name Tight */
:root {
  --layout-gap: 4px;
  --layout-radius: 6px;
  --layout-row-height: 26px;
}
:root [data-region="row"] { border-radius: 4px; }
```

A full example covering spacing, borders/radii, surfaces, split panes and
native material is in [`docs/examples/layouts/roomy-cards.css`](examples/layouts/roomy-cards.css).
Hairline Ledger (`src/lib/layouts/hairline-ledger.css`) and Soft Cards
(`soft-cards.css`) are written against the same contract and are larger
references; `compact-density.css` shows the compact density rules.

## Fallback and recovery

The selected layout falls back to **Default** when its file is missing,
unreadable, empty, over the size limit, has an unclosed leading comment,
parses to no CSS rules, or (for a built-in) its stylesheet fails to load. The selection itself is kept, so restoring the file
restores the layout. A notice explains the failure once, and the Layout
setting shows the reason with **Reset to Default**.

If a layout makes the window unusable:

- Settings → Appearance → Layout → **Reset to Default**, or run
  **Switch Layout...** from the command palette (Ctrl+Shift+P).
- Or delete or rename the file in the layouts folder; the window returns to
  Default as soon as the change is noticed.
- Or set `"layoutTheme": "default"` in `<config>/settings.json`.

The last applied layout is cached so it paints on the first frame after a
restart. Layouts whose stylesheets total more than 256K characters are not
cached and briefly paint Default at startup.

## Migration

The former **Floating Islands** toggle (`floatingIslands`) became the
`layoutTheme` setting. Settings saved by older versions migrate once: the
toggle, or the macOS vibrancy / Windows backdrop options that used to imply
islands, select `floating-islands`. Native material settings are otherwise
unchanged and now combine with any layout.

The macOS **Window Vibrancy** / **Native Blur** toggles and the Windows
**Window Backdrop** / **Backdrop Opacity** options became one
**Translucency** setting with the **Translucency Opacity** slider (#1757).
Either platform's former setting turns Translucency on, and a Windows
Backdrop Opacity becomes the slider value that gives islands the same alpha.

The **Compact** layout (`"layoutTheme": "compact"`, #1548) became the
**Compact** setting (#1878). A saved `"layoutTheme": "compact"` loads as
`"layoutTheme": "default"` with `"compact": true`, which looks the same,
and is written back that way. The id is folded whenever settings load, not
once, so a value written again by an older build migrates too. A user
layout with `@extends compact` resolves as Default; turn Compact on to get
the tighter sizes back.
