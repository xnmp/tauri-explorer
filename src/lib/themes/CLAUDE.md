# Theme rules

- Repository-folder Git badges read `--icon-git-badge` from each active theme;
  keep it distinct from `--icon-folder` (the Hacker theme deliberately uses its
  darker terminal green) and cover every file-list view mode when changing it.
- Keep the badge's compact corner geometry (`FileIcon.svelte`) and its
  `--icon-git-badge` / `--icon-git-badge-glyph` theme overrides together when
  polishing the SVG (#601). Component rules: `src/lib/components/CLAUDE.md`.
