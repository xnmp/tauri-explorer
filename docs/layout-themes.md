# Layout themes

A **layout theme** controls the structure of the window: spacing between
panels, borders, corner radii, panel surfaces, chrome density and the Details
row height. It is independent of the **colour theme** (Settings → Appearance →
Color Theme), which supplies the palette. Any layout can be combined with any
colour theme.

Three layouts are built in:

| Layout | Id | What it does |
| --- | --- | --- |
| Default | `default` | The flat, edge-to-edge layout. |
| Floating Islands | `floating-islands` | Rounded panels floating over the window backdrop (#277, #434). Ships in the startup CSS. |
| Hairline Ledger | `hairline-ledger` | Square, dense panels ruled by 1px hairlines, monospaced metadata and an inverted selection. Loaded on demand. |

Choose one in **Settings → Appearance → Layout**, with **Switch Layout...** in the
command palette (live preview while you move through the list), or with
**Toggle Floating Islands Layout**.

## Installing a custom layout

1. Settings → Appearance → Layout → **Open folder**. This creates and
   opens `<config>/layouts/`:
   - Linux: `~/.config/tauri-explorer/layouts/`
   - macOS: `~/Library/Application Support/tauri-explorer/layouts/`
   - Windows: `%APPDATA%\tauri-explorer\layouts\`
2. Save a `.css` file there, for example
   [`docs/examples/layouts/soft-cards.css`](examples/layouts/soft-cards.css).
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
 * @name Soft Cards
 * @description Roomy rounded cards on a quiet backdrop.
 * @extends floating-islands
 */
```

| Key | Meaning |
| --- | --- |
| `@name` | Name shown in the selector. Defaults to the file name in title case (`dense-grid.css` → "Dense Grid"). |
| `@description` | Shown in the layout picker. |
| `@extends` | Built-in base: `default` (the default), `floating-islands` or `hairline-ledger`. The base's stylesheet and structural arrangement apply first and your file cascades on top. An unknown value means `default`. |

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
| `--layout-hairline` | `var(--divider)` | Rule colour between chrome regions. |
| `--layout-row-height` | `32px` | Details row height, in `px`, clamped to 20–64. Virtual scrolling and marquee selection follow it. |

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
| `titlebar` | Title bar containing the tab strip | |
| `tab-strip` | Window tab strip | |
| `tab` | One window tab | `aria-selected="true"` on the active tab |
| `tab-fillet` | Curves joining the active tab to the content | `data-side="left\|right"` |
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
| `split-divider` | Divider between split panes | `aria-orientation` |
| `toolbar` | Pane navigation bar | |
| `address-bar` | Breadcrumb / path field | |
| `file-list` | File list of any view | `data-view="details\|list\|tiles"` |
| `column-header` | Details column header | |
| `row` | One entry, in every view (scope with `[data-view]` on `file-list`) | `aria-selected="true"` when selected |
| `[data-cell]` | Details cells: `name`, `date`, `type`, `size`, `length`, `resolution` | |
| `preview` | Preview panel wrapper | |
| `preview-body` | Preview panel content | `data-fullscreen` while fullscreen |
| `scm` | Source control panel | `data-island` when floating |
| `terminal` | Terminal panel | |
| `status-bar` | Status bar | |

Root (`<html>`) attributes describe the window and can scope rules:

| Attribute | Meaning |
| --- | --- |
| `data-layout` | Applied layout id (`default` after a fallback). |
| `data-layout-base` | Applied built-in base. |
| `data-theme` | Active colour theme id. |
| `data-native-backdrop` | Native window material is on (macOS vibrancy with blur, Windows Mica/Acrylic). The body is transparent; paint opaque surfaces only where you want them. |
| `data-transparent-window` | The window was created transparent (macOS vibrancy). Without `data-native-backdrop` the body is painted opaque. |
| `data-win-backdrop` | Windows material kind (`mica`, `acrylic`, ...). |
| `data-preview-fullscreen` | A preview is fullscreen. |

### Native window material

Native material is a separate window capability, never part of a layout. A
layout must look right both with and without it: scope translucent surfaces
to `:root[data-native-backdrop]` and keep them opaque otherwise.

## Precedence

1. Application styles (component CSS, colour theme).
2. Floating Islands rules, scoped to `:root[data-layout-base="floating-islands"]`.
3. The base stylesheet of a lazily loaded built-in (Hairline Ledger).
4. Your layout file.

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
native material is in [`docs/examples/layouts/soft-cards.css`](examples/layouts/soft-cards.css).
Hairline Ledger (`src/lib/layouts/hairline-ledger.css`) is written against the
same contract and is a larger reference.

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
