# Theme rules

- Repository-folder Git badges read `--icon-git-badge` from each active theme;
  keep it distinct from `--icon-folder` (the Hacker theme deliberately uses its
  darker terminal green) and cover every file-list view mode when changing it.
- Keep the badge's compact corner geometry (`FileIcon.svelte`) and its
  `--icon-git-badge` / `--icon-git-badge-glyph` theme overrides together when
  polishing the SVG (#601). Component rules: `src/lib/components/CLAUDE.md`.
- File-list Git status colours (tinted names and status chips, #1852) are the
  `--git-*` variables in `git-status.css`: `light-dark()` defaults at zero
  specificity (`:where(:root)`), so a theme overrides one by setting it in its
  `[data-theme]` block. Keep light shades at >= 4.5:1 against the list and its
  selected rows; `domain/git-status-presentation.ts` maps statuses to them.
