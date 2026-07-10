# Session Handover — as of 2026-07-10

Continuing work on tauri-explorer — get ready for the next round of features.

**Previous session summary:** Fixed and shipped all 10 open UX issues (#233–#242) in one pass: shortcut-badge theming, address-bar flash, command-palette lag, tab hover fillet, fullscreen-preview center + pan/zoom, Alt+M T integrated terminal, tab-strip blending, directional pane hotkey defaults, marquee-at-zoom regression (+ WebKit e2e coverage), and drag-hover highlight blinking. Each got its own `fix/<slug>` branch, screenshots, tests, and a `--no-ff` merge to `dev`; all issues closed, `dev` pushed.

**Key context:**
- `dev` is green and pushed: 502/502 e2e (`ALL_VIEW_MODES=1`), 924 unit tests, 0 svelte-check errors.
- `new_todo.md` is empty and there is no open issue backlog from this batch — next session starts by taking new feature requests, converting them into GitHub issues (with `## Screenshots` checkbox section), then one branch per issue.
- Default directional split hotkeys are now **Cmd/Super+Alt + P/L/;/'** (#239); any new e2e or docs must use `Meta+Alt+…`, not `Ctrl+Alt`.
- Command palette / QuickOpen / ContentSearch have **no entrance animation** by design (#234) — don't "polish" one back in; keystroke-summoned surfaces must be legible on their first frame.
- Fullscreen overlays that must cover the visible viewport need `zoom: calc(1 / var(--app-zoom, 1))` — `--app-zoom` is set alongside `documentElement.style.zoom` in `+page.svelte` (#236). Reuse it for any future fullscreen/overlay feature.
- `screenshots/_issue-refs/` is intentionally untracked (user's clipboard references for issues #238/#240); leave or ask before touching.

**Current state:** Everything merged and working; no in-progress branches; working tree clean except untracked `.rtk_tmp` and `screenshots/_issue-refs/` (and this handover file — do NOT commit it).

**Next steps:** Ask the user for the next feature list (or check `new_todo.md` / new GitHub issues), write implementation plans, create issues, then follow the per-issue checklist in CLAUDE.md.

---

## Architecture & Learnings

### Frontend layout (`src/lib/`)
- `domain/` — pure logic, no framework deps. Notable: `zoom.ts` (coordinate conversions under CSS zoom), `keybinding-parser.ts` (chords, `Cmd`→meta aliasing, display formatting), `path.ts`, `fuzzy-score.ts`.
- `state/` — Svelte 5 rune stores. `settings.svelte.ts` (all persisted settings + `TOGGLE_SETTINGS` command metadata), `commands/` (palette command registries: `pane-commands.ts`, `general-commands.ts`, `navigation-commands.ts`), `window-tabs.svelte.ts`, `terminal.svelte.ts` (integrated terminal visibility), **new:** `home.svelte.ts` (app-wide cached home dir — read `homeDirectory.value` synchronously instead of calling `getHomeDirectory()` per component).
- `composables/` — `use-drop-target.svelte.ts` (folder drop highlight; dragleave now child-aware), `use-marquee-selection.svelte.ts`, `use-native-drop-target.svelte.ts` (position-based highlight via `elementFromPoint`), `use-pointer-drag.svelte.ts`.
- `components/` — `WindowTabBar.svelte` (tabs + fillets + hover pill), `PreviewPane.svelte` (preview + fullscreen pan/zoom), `Modal.svelte` + `modal.css` (shared dialog chrome), `NavigationBar.svelte` (breadcrumbs/anchor icons), `ShortcutCheatsheet.svelte` (Ctrl+/).
- Entry: `src/routes/+page.svelte` — global shortcuts (Ctrl+`, Ctrl+\, zoom effect setting `--app-zoom`), lazy-mounts PreviewPane/TerminalPanel behind settings flags.

### CSS zoom coordinate model (IMPORTANT — recurring bug source)
Standardized CSS zoom (Interop 2024; Chromium ≥128, WebKitGTK ≥2.44): `clientX/Y` **and** `getBoundingClientRect()` are both post-zoom viewport px on EVERY engine. All converters in `domain/zoom.ts` are now single-division/multiplication and engine-independent (`clientToCSSRelative`, `rectDimToCSS`, `cssToRect`, `fixedFromClient`, `fixedFromRect`). The legacy "WebKitGTK reports pre-zoom rects" model is DEAD — if you find an engine branch on zoom coordinates, it's a bug. When touching `domain/zoom.ts`, run `PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true WEBKIT=1 npx playwright test e2e/zoom-positioning.spec.ts --project=webkit`.
Also: `position: fixed; width: 100vw` does NOT cover the visible viewport under root zoom — cancel with `zoom: calc(1 / var(--app-zoom, 1))`.

### Theming (recurring bug source)
Theme token set lives in `src/lib/themes/*.css` (`dark.css` is the reference list). There is NO `--background`, `--background-secondary`, `--border-color`, or `--accent-color` — grep `src/lib/themes/` before using a token. Correct idioms: controls `--control-fill`/`--control-stroke`, subtle chips `--subtle-fill-tertiary`, cards `--background-card`, accents `--accent`/`--text-on-accent`. Never write `var(--foo, #f5f5f5)`-style light fallbacks — they silently paint white on dark themes.

### Tab bar (`WindowTabBar.svelte`)
- `.tab-area` is `background: transparent` — the titlebar owns the strip surface. Never re-add a background layer to a child strip.
- Active tab fuses to the pane via `.tab-fillet` spans (concave radial-gradient corners, z-index 3). Unfocused hover is an inset pill on `::before` (`inset: 4px 2px 3px`) so it can't collide with fillets.
- Unfocused tabs: `--control-fill-tertiary` fill, `--text-secondary` text, opacity 1.

### Drag & drop
- Linux uses HTML5 DnD (`usesHtml5Drag = !isMac && !isWindows` in `domain/platform.ts`); mac/windows use pointer-drag + `elementFromPoint` highlighting.
- dragenter/dragleave pair per ELEMENT not subtree: `useDropTarget.handleDragLeave(event, entry)` ignores leaves into the row's own children (relatedTarget containment; coordinate-in-rect fallback because WebKit's dragleave relatedTarget is null; (0,0)+null = window exit, clears).
- Playwright synthetic DnD does NOT validate real browser DnD.

### Testing & verification workflow
- Unit: `bun run test` (also runs perf suite — one perf benchmark is occasionally flaky under load; rerun before believing a failure). Single file: `bunx vitest run tests/path/file.test.ts`.
- E2E: `npx playwright test` (Chromium, dev server on 1420); full gate before ending a session: `ALL_VIEW_MODES=1 npx playwright test`. E2E failures in `beforeEach` timeouts are usually load contention — close stray agent-browser sessions and retry the spec in isolation before debugging.
- WebKit project (`WEBKIT=1 … --project=webkit`) is the only thing that exercises the engine the real Linux app runs — use it for anything coordinate/zoom/drag related.
- rtk truncates long playwright output; use `rtk proxy npx playwright test --reporter=line` for full output.
- agent-browser: set `AGENT_BROWSER_SESSION=<name>` per task; screenshots MUST go to `screenshots/<branch>/` (a hook enforces the relative path). Gotchas: inline previews of dark modals can look white — pixel-sample with `ffmpeg -vf "crop=1:1:X:Y" -f rawvideo -pix_fmt rgb24 - | od -An -tu1`; DOM reads right after `dispatchEvent` in eval are stale (Svelte batches) — wrap in setTimeout/rAF; the daemon drops commands when too many are batched in one bash call; `document.dispatchEvent(keydown)` bubbles to window-capture handlers.
- Palette-driven testing: preview pane toggles with **Space**; "Toggle Preview Pane" is hidden from the palette because its `when()` excludes input focus (the palette input itself) — pre-existing quirk, arguably a bug worth an issue.

### Workflow reminders (hooks enforce these)
- Branch names need a matching open GitHub issue (`fix/<slug>` ↔ issue title containing `<slug>`); re-use the issue's branch name for follow-up commits (e.g. e2e fix for #239 reused `fix/directional-pane-hotkeys`).
- Merge hook: `git merge <branch> --no-ff -m …` — branch name must come FIRST after `merge`; screenshots must be COMMITTED on the feature branch before merging; "None required" in the issue's Screenshots section skips the check.
- Issues do not reliably auto-close on merge — close manually with `gh issue close <n> --comment "..."`.
- Update `docs/lessons_learnt.md` (append at bottom) for every behavioral bugfix; this session added five entries worth skimming.
