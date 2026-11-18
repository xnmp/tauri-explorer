# Domain-layer rules

`domain/` is pure logic with no framework dependencies. Rules for domain modules
that live with their main consumer:

- `zoom.ts` (`fixedFromClient`, `fixedFromRect`, `fixedMenuPosition`), `marquee-rect.ts`, `overlays.ts`, `retained-tabs.ts`, `pane-viewport.ts`, `html-preview-zoom.ts`, `csv-preview.ts` → `src/lib/components/CLAUDE.md`
- `preview-kind.ts` → `src/lib/state/CLAUDE.md` § Previews
- `git-graph*.ts` (lineage from `assignLayout`) → `src/lib/components/git-graph/CLAUDE.md`
- `quick-open-ranking.ts` → `src/lib/state/CLAUDE.md` § Quick Open

## Terminal key ownership

Terminal focus gives terminal-hosted applications ownership of every key except the small, availability-aware core-navigation allowlist in `domain/terminal-keys.ts` (Quick Open, Command Palette, previous/next tab, and the configured terminal-toggle chord). Keep the ownership decision shared by `+page.svelte` and `TerminalPanel.svelte`; chord prefixes and suffixes must be checked against the eligible command ID so other chords sharing a prefix stay terminal-owned, and a terminal-owned mismatching suffix must cancel the pending Explorer chord before another key can complete it.

## List peek stages (#1365)

List peek stages never move a folder's header (#1365): every open header uses
the `SPRING_CARD_FIT` rule in `sizeListModel`, "+N more" spills rows (cut while
flowing, never in `buildListStructure`, which must not depend on R) before full
flow, Less always returns to the compact card, and closing forgets the stage.
Spilled rows hidden behind "+N more" have no slot (`entryItem` -1).

## Bookmark drop feedback (#675)

Bookmark feedback must state the action for the source kind: directory drags always say `Drop to pin`, including a targeted bookmark row; only files on a targeted row say `Move to bookmark`. Resolve that kind from in-memory drag state or the persisted cross-window fallback, matching native drop handling (#675). Drop surfaces: `src/lib/components/CLAUDE.md` § Drag and drop.

## Markdown frontmatter (ADR 0007)

Markdown frontmatter is parsed in `domain/markdown.ts` before Marked renders the document body. Only non-empty YAML maps made of scalar values or scalar arrays become the preview's properties panel; malformed, empty, or nested metadata falls back to ordinary Markdown rendering.

## Launch parameters

Read every one-shot launch query parameter through `launchRequest` in `domain/window-launch-plan.ts` so a recovered document restores its session instead of replaying the launch. Renderer recovery: `src-tauri/src/renderer_owner/CLAUDE.md`.
