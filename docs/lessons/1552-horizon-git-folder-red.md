# #1552 — Horizon repository folders read as errors

Since #1490 a repository folder is painted entirely in `--icon-git-badge`
(FolderIcon, FolderThumbnail, CatppuccinFileIcon, in every view mode). Most
themes alias that token to `--accent`, which is fine when the accent is a calm
hue. Horizon's accent is `#e95678`, the same colour as its `--system-critical`,
so every repository looked like a failed/error folder.

Fix: Horizon sets `--icon-git-badge: #b877db` (Horizon's lavender), distinct
from its peach `--icon-folder` and 5:1+ against `--background-solid`.

Guard: `tests/themes/git-repository-tint.test.ts` resolves each built-in
theme's `--icon-git-badge` (following `var()` aliases) and requires it to sit
at least 20° of hue from `--system-critical`, differ from `--icon-folder`, and
meet 3:1 non-text contrast on the window surface. When adding a theme whose
accent is red, give `--icon-git-badge` its own value instead of `var(--accent)`.

Environment note: worktrees under `.claude/` (a dot directory) make Vite 8's
dependency optimizer fail with `Could not resolve 'node:module' in
\0rolldown/runtime.js … Tsconfig not found`. Run Vitest/Playwright from a
mirror outside dot directories; a hardlinked mirror (`cp -al`) shares inodes,
so evidence screenshots it rewrites also change the worktree's tracked files.
