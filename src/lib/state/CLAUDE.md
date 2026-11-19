# State-layer rules

Root `CLAUDE.md` holds the refresh split (WHEN=`refresh-manager`,
WHETHER=`pane-watch`, HOW=`pane-refresh`) and the no-state-in-components rule.
Rules for state modules that live elsewhere:

- `git-graph-*.ts`, `git-pr-*.svelte.ts`, `git-avatar-cache.ts` → `src/lib/components/git-graph/CLAUDE.md`
- `image-resolution.ts` (Details metadata) → `src/lib/components/CLAUDE.md` § Details view
- `drive-opening.ts` (Linux volumes, ADR 0025) → `src-tauri/src/files/CLAUDE.md`
- `user-report-draft.svelte.ts` → `website/api/CLAUDE.md`
- `startup-timing.ts`, `window-session.ts` startup marks → `e2e-tauri/CLAUDE.md` § Native qualification
- `terminal-key-handler.ts` → `src/lib/domain/CLAUDE.md` (terminal key ownership)

## Watchers and listings

- Watcher callbacks are delayed work: capture the explorer path when queuing a refresh and drop the callback if that explorer navigates before it runs. Preserve the backend observation time too: notify delivery can lag behind a trailing listing, and treating an already-covered change as new work creates a third refresh. Otherwise an event attributed to the old directory refreshes the new one and corrupts both directories' cadence.
- Miller columns cache ancestor listings independently of the active pane. Publish the affected parent directory after local mutations so their visible source column refreshes immediately (#598).
- The sidebar Recycle Bin opens the in-app `trash://` location (#863), served by the built-in fs provider `state/trash-provider.ts`, which lazily loads `state/trash-location.ts` (listing, restore, menu actions) to keep the startup bundle under its cap. Restore sends only opaque entry IDs; the native registry maps them to artifacts captured by that listing, so the renderer can never name a trash payload (ADR 0019). A trash view has no watcher: anything that changes the trash publishes `trash://` through `broadcastFileChange`, and a failed trash listing is not a history entry.

## Quick Open (#600, #651, #1007)

Quick Open keeps local active-pane/recent/frecency matches immediate and caps the merged rendered list at 20 rows; rendering thousands of active-directory matches blocks the input even when matching itself is cheap. Its recursive backend walk goes through `state/quick-open-session.svelte.ts` (ranking in `domain/quick-open-ranking.ts`); retain its trailing debounce and invalidate an active stream on new input so large deferred trees do not compete with typing. Detach the captured stream listener before awaiting cancellation IPC, or a late cancellation can remove its replacement (#600, #651). The backend half (search cache coverage, epochs, recursive watch admission and cancellation) is in `src-tauri/src/files/CLAUDE.md`.

## Windows: titles, launch and startup

- Native window titles have two phases: every creation path (Rust main, fresh child, parked warm window) must seed the requested title before visibility, then the page's reactive `window-title` sync follows the active explorer path across navigation/tab/pane changes.
- New-window address-bar focus likewise has fresh and warm paths: fresh children request it through their launch URL, while activated warm windows dispatch the request only after the requested navigation and native focus. Wait for the explorer's initial path before mounting `BreadcrumbAutocomplete`, because it captures that path only on mount.
- Startup marks belong to one owner: `window-session` records `mount`/`settings-ready`/`commands-ready`, `+page.svelte` only `bundle-exec`/`list-ready`/`app-ready`. `startup-timing` mirrors each recorded main-window mark (plus a bounded heartbeat) as a `Startup(webview-progress)` line; this adds no marks and changes no ownership (#936).

## Previews

Preview file-kind precedence lives only in `domain/preview-kind.ts`. File loaders,
image holds/cache ownership and rendition upgrades live in `state/preview-content.ts`;
replace `PreviewContent` as a whole. Keep selection-effect reads of content and
geometry untracked so publishing a preview cannot start another request (#1206).
Supply lazy PDF/video viewer factories from the component; even type-only
component imports in state violate the architecture boundary (`bun run lint:arch`).

Video frames in `PreviewPane.svelte` come from `getVideoThumbnailData`, not the
tile component. Keep its asynchronous results guarded by the full preview
revision (path, mtime, and size), because a watcher can update a selected video
without changing its path (#607).
The preview pane requests a 1024px video frame because fullscreen reuses that
same source; tile views keep their independently configured 96–256px requests
and cache keys (#664).

Rendering rules for previews (HTML, CSV, PDF, Markdown, image zoom, docks):
`src/lib/components/CLAUDE.md` § Previews.
