# #1823 audit-frontend-batch

- Store mutations that return `ApiResult` must be surfaced: `scm.stage/unstage` now return `{ok, error}` and `stagePaths` (scm-sidebar-actions) / preview diff actions report the failure.
- Quick Open: `done` is final for a search id (later same-id events are ignored); a rejected fallback search must still clear `loading`.
- Command-owned UI hints come from `getCommandShortcut` (ContextMenu hints, `shortcutSuffix` for settings copy). ShortcutCheatsheet's three built-in entries (Ctrl+, / Ctrl+J / Ctrl+\) are genuinely fixed surface keys in `domain/window-keys.ts`, not stale hints.
- Fill tokens (`--accent`, `--system-*`) as text colour go through `-text` variants (theme-token-contrast test).
- Undefined tokens replaced by defined ones: `--background-card`, `--accent`, `--system-caution`; `--scm-*` status colours now derive from the system status tokens.
- Not reproduced/deferred: `ThumbnailImage` stale `microUrl` on key change (needs a mounted-component repro; vitest runs in node).
