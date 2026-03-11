# UI Facelift — Refined & Modern Polish

**Issue**: tauri-l0q9 (status: in_progress)
**Branch**: `ui-facelift`

## Context

The explorer currently uses a Windows 11 Fluent Design system that feels generic — default system fonts, flat gray surfaces, minimal depth hierarchy. The goal is a **refined & modern** facelift that makes everything feel more premium while preserving full theme extensibility.

**Direction**: Clean lines, better spatial hierarchy, subtle depth, premium feel. Think macOS Finder quality polish — not a radical redesign, but everything feels a tier above.

**Constraint**: All visual changes flow through CSS variables and global styles so themes can override everything.

## Files to Modify

1. `src/routes/+page.svelte` — Global CSS tokens (typography, spacing, transitions, scrollbars)
2. `src/lib/themes/light.css` — Refined light palette
3. `src/lib/themes/dark.css` — Refined dark palette
4. `src/lib/components/SharedToolbar.svelte` — Toolbar polish
5. `src/lib/components/NavigationBar.svelte` — Breadcrumb bar polish
6. `src/lib/components/Sidebar.svelte` — Sidebar polish
7. `src/lib/components/StatusBar.svelte` — Status bar polish
8. `src/lib/components/FileList.svelte` — File list/tiles view polish
9. `src/lib/components/FileItem.svelte` — Details view row polish

## Changes

### 1. Global Tokens (`+page.svelte :global(:root)`)

**Typography**: Add new CSS variables for font weight and letter-spacing. Use `-apple-system, BlinkMacSystemFont, "Segoe UI Variable", "Segoe UI", sans-serif` ordering (prioritizes SF Pro on macOS for native feel).

```
--font-weight-normal: 400
--font-weight-medium: 500
--font-weight-semibold: 600
--letter-spacing-tight: -0.01em   (headings)
--letter-spacing-normal: 0em      (body)
```

**Radii**: Slightly larger for a softer feel:
```
--radius-sm: 6px   (was 4px)
--radius-md: 10px  (was 8px)
--radius-lg: 14px  (was 12px)
```

**Transitions**: Slightly snappier:
```
--transition-fast: 80ms cubic-bezier(0.25, 0.1, 0.25, 1)
--transition-normal: 150ms cubic-bezier(0.25, 0.1, 0.25, 1)
```

**Scrollbars**: Thinner, more refined (10px width, 3px border for skinnier thumb).

### 2. Light Theme (`light.css`)

Shift from flat gray (#f3f3f3) to a warmer, more nuanced palette:

- **Accent**: `#2563eb` (richer blue, less Windows-generic)
- **Accent light**: `#60a5fa`, **dark**: `#1d4ed8`
- **Text primary**: `#111827` (deeper, richer black)
- **Text secondary**: `#6b7280` (warmer gray)
- **Text tertiary**: `#9ca3af`
- **Background solid**: `#f8f9fa` (warmer off-white)
- **Background mica**: `rgba(248, 249, 250, 0.88)`
- **Background card**: `rgba(255, 255, 255, 0.75)`
- **Background card-secondary**: `rgba(245, 246, 248, 0.6)`
- **Divider**: `rgba(0, 0, 0, 0.06)` (subtler)
- **Shadows**: More layered, softer spread
- **Folder icon**: `#f59e0b` (warmer amber)

### 3. Dark Theme (`dark.css`)

Richer, deeper dark with more contrast:

- **Accent**: `#60a5fa` (softer blue, less cyan)
- **Accent light**: `#93c5fd`, **dark**: `#2563eb`
- **Text primary**: `#f3f4f6` (slightly warmer white)
- **Text secondary**: `#9ca3af`
- **Text tertiary**: `#6b7280`
- **Background solid**: `#111827` (deep navy-black, not flat gray)
- **Background mica**: `rgba(17, 24, 39, 0.96)`
- **Background card**: `rgba(31, 41, 55, 0.7)`
- **Background card-secondary**: `rgba(24, 33, 48, 0.6)`
- **Divider**: `rgba(255, 255, 255, 0.08)`
- **Shadows**: Deeper, with slight blue tint
- **Folder icon**: `#fbbf24`

### 4. Component Polish

**SharedToolbar**: Search box gets `border-radius: var(--radius-md)` (pill-ish), height 34px. Subtle bottom shadow instead of hard border. Window control buttons: 40px wide, border-radius: var(--radius-sm).

**NavigationBar**: Breadcrumb container gets `border-radius: var(--radius-sm)`, softer border. Nav buttons: 28px, slightly larger, `border-radius: var(--radius-sm)`.

**Sidebar**: Section headers use `font-weight: var(--font-weight-medium)`, `letter-spacing: var(--letter-spacing-tight)`, `font-size: 11px`, `text-transform: uppercase`, `color: var(--text-tertiary)` for a refined label feel. Nav items: `border-radius: var(--radius-sm)`, 34px min-height. Usage bars: 4px height, rounded.

**StatusBar**: Height 28px (was 24), `font-size: 12px` (was 11px), left padding 16px.

**FileList**:
- Column headers: `text-transform: uppercase`, `font-size: 11px`, `letter-spacing: 0.04em`, `font-weight: var(--font-weight-medium)`, `color: var(--text-tertiary)`.
- List items: `border-radius: var(--radius-sm)`, slightly more padding.
- Tile items: `border-radius: var(--radius-md)`, font-size 13px already done.

**FileItem**: Row height stays compact. border-radius: var(--radius-sm).

### 5. Mica overlay gradient

Update the `::before` gradient to be theme-aware using a new CSS variable `--mica-overlay` that themes can set. Default: subtle warm highlight.

## Verification

1. Run `./scripts/dev.sh` and visually inspect both light and dark themes
2. Check all view modes (list, tiles, details)
3. Verify sidebar, toolbar, breadcrumbs, status bar look refined
4. Switch between all 6 themes to ensure nothing breaks
5. Run `npx vitest run` for regressions
