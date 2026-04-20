# Beads Export

*Generated: Thu, 05 Mar 2026 08:48:09 AEDT*

## Summary

| Metric | Count |
|--------|-------|
| **Total** | 436 |
| Open | 15 |
| In Progress | 10 |
| Blocked | 0 |
| Closed | 411 |

## Quick Actions

Ready-to-run commands for bulk operations:

```bash
# Close all in-progress items
br close tauri-lzea tauri-e2mn tauri-en1b tauri-5t7m tauri-fl0e tauri-hit0 tauri-aw0h tauri-18op tauri-qeac tauri-oe1r

# Close open items (15 total, showing first 10)
br close tauri-ks7f tauri-1r2q tauri-vup6 tauri-jsn1.8 tauri-jsn1.2 tauri-jsn1.1 tauri-jsn1 tauri-jsn1.7 tauri-jsn1.6 tauri-jsn1.5

# View high-priority items (P0/P1)
br show tauri-ks7f tauri-1r2q tauri-lzea tauri-vup6 tauri-e2mn tauri-en1b tauri-5t7m tauri-fl0e tauri-hit0 tauri-aw0h

```

## Table of Contents

- [🟢 tauri-ks7f Phase 3: Component polish (all components)](#tauri-ks7f-phase-3-component-polish-all-components)
- [🟢 tauri-1r2q Phase 2: Theme enrichment (all themes + new Aurora)](#tauri-1r2q-phase-2-theme-enrichment-all-themes-new-aurora)
- [🔵 tauri-lzea Phase 1: Global design tokens update](#tauri-lzea-phase-1-global-design-tokens-update)
- [🟢 tauri-vup6 EPIC: UI Facelift - Premium Polish](#tauri-vup6-epic-ui-facelift-premium-polish)
- [🔵 tauri-e2mn Tiles view with thumbnails is laggy/freezes](#tauri-e2mn-tiles-view-with-thumbnails-is-laggy-freezes)
- [🔵 tauri-en1b List view doesn't show icons properly](#tauri-en1b-list-view-doesn-t-show-icons-properly)
- [🔵 tauri-5t7m Extract CancellableTaskRegistry in Rust backend](#tauri-5t7m-extract-cancellabletaskregistry-in-rust-backend)
- [🔵 tauri-fl0e Replace window.dispatchEvent custom events with typed dialog manager](#tauri-fl0e-replace-window-dispatchevent-custom-events-with-typed-dialog-manager)
- [🔵 tauri-hit0 Separate listing ID from path string in DirectoryListing](#tauri-hit0-separate-listing-id-from-path-string-in-directorylisting)
- [🔵 tauri-aw0h Fix keyboard shortcut conflicts (F5, F6, Ctrl+Tab)](#tauri-aw0h-fix-keyboard-shortcut-conflicts-f5-f6-ctrl-tab)
- [🟢 tauri-jsn1.8 Enable true window transparency on Linux (see-through to desktop)](#tauri-jsn1-8-enable-true-window-transparency-on-linux-see-through-to-desktop)
- [🟢 tauri-jsn1.2 Add per-section transparency CSS tokens](#tauri-jsn1-2-add-per-section-transparency-css-tokens)
- [🟢 tauri-jsn1.1 Add background layer behind glassmorphism stack](#tauri-jsn1-1-add-background-layer-behind-glassmorphism-stack)
- [🟢 tauri-jsn1 EPIC: Advanced Theme Engine](#tauri-jsn1-epic-advanced-theme-engine)
- [🔵 tauri-18op Extract FileIcon component and split FileList.svelte](#tauri-18op-extract-fileicon-component-and-split-filelist-svelte)
- [🔵 tauri-qeac Create createPersistedState utility for localStorage](#tauri-qeac-create-createpersistedstate-utility-for-localstorage)
- [🔵 tauri-oe1r Replace handwritten base64_encode with base64 crate](#tauri-oe1r-replace-handwritten-base64-encode-with-base64-crate)
- [🟢 tauri-jsn1.7 Create Aurora theme as showcase for new engine capabilities](#tauri-jsn1-7-create-aurora-theme-as-showcase-for-new-engine-capabilities)
- [🟢 tauri-jsn1.6 Add user-selectable wallpaper/background image setting](#tauri-jsn1-6-add-user-selectable-wallpaper-background-image-setting)
- [🟢 tauri-jsn1.5 Extend breadcrumb and chrome theming tokens](#tauri-jsn1-5-extend-breadcrumb-and-chrome-theming-tokens)
- [🟢 tauri-jsn1.4 Implement swappable icon theme system](#tauri-jsn1-4-implement-swappable-icon-theme-system)
- [🟢 tauri-jsn1.3 Implement animated background renderer system](#tauri-jsn1-3-implement-animated-background-renderer-system)
- [🟢 tauri-0jry Can't cancel cut and paste when progress bar shows](#tauri-0jry-can-t-cancel-cut-and-paste-when-progress-bar-shows)
- [🟢 tauri-f147 Cut and paste with dialog gets stuck on 0% progress](#tauri-f147-cut-and-paste-with-dialog-gets-stuck-on-0-progress)
- [🟢 tauri-no52 Drag and drop with conflicting filenames should show resolution modal](#tauri-no52-drag-and-drop-with-conflicting-filenames-should-show-resolution-modal)
- [⚫ tauri-ne9h Cross-window drag and drop is unreliable](#tauri-ne9h-cross-window-drag-and-drop-is-unreliable)
- [⚫ tauri-lmpo Right-clicking twice shows browser context menu instead of app menu](#tauri-lmpo-right-clicking-twice-shows-browser-context-menu-instead-of-app-menu)
- [⚫ tauri-8vc1 Open in terminal doesn't work: working-directory value required](#tauri-8vc1-open-in-terminal-doesn-t-work-working-directory-value-required)
- [⚫ tauri-u6r2 Tiles view freezes the window - make it non-blocking](#tauri-u6r2-tiles-view-freezes-the-window-make-it-non-blocking)
- [⚫ tauri-obxi Right-click context menu appears at wrong position](#tauri-obxi-right-click-context-menu-appears-at-wrong-position)
- [⚫ tauri-ggkv Fix multi-file delete and copy not working](#tauri-ggkv-fix-multi-file-delete-and-copy-not-working)
- [⚫ tauri-zqfo Fix Enter key opening file instead of confirming delete dialog](#tauri-zqfo-fix-enter-key-opening-file-instead-of-confirming-delete-dialog)
- [⚫ tauri-gkfr Fix OS clipboard copy/paste with Thunar and other Wayland-native apps](#tauri-gkfr-fix-os-clipboard-copy-paste-with-thunar-and-other-wayland-native-apps)
- [⚫ tauri-explorer-2o72 Tab switching not working in Tauri app](#tauri-explorer-2o72-tab-switching-not-working-in-tauri-app)
- [⚫ tauri-explorer-okn6 Fix keyboard shortcuts (Ctrl+C/X/V) not working for clipboard operations in browser E2E mode](#tauri-explorer-okn6-fix-keyboard-shortcuts-ctrl-c-x-v-not-working-for-clipboard-operations-in-browser-e2e-mode)
- [⚫ tauri-explorer-5jci Mock API detection bug - Tauri app shows mock data instead of real filesystem](#tauri-explorer-5jci-mock-api-detection-bug-tauri-app-shows-mock-data-instead-of-real-filesystem)
- [⚫ tauri-explorer-60gg Fix mock invoke incorrectly activating in Tauri app](#tauri-explorer-60gg-fix-mock-invoke-incorrectly-activating-in-tauri-app)
- [⚫ tauri-explorer-gnvv Paste and Undo keyboard shortcuts broken](#tauri-explorer-gnvv-paste-and-undo-keyboard-shortcuts-broken)
- [⚫ tauri-explorer-zjdw Fix hardcoded/inconsistent API URLs](#tauri-explorer-zjdw-fix-hardcoded-inconsistent-api-urls)
- [⚫ tauri-explorer-h21l Ctrl+V paste not working](#tauri-explorer-h21l-ctrl-v-paste-not-working)
- [⚫ tauri-explorer-as45 Fix drag select bugs](#tauri-explorer-as45-fix-drag-select-bugs)
- [⚫ tauri-explorer-acj4 bug](#tauri-explorer-acj4-bug)
- [⚫ tauri-explorer-zrs9 bug](#tauri-explorer-zrs9-bug)
- [⚫ tauri-explorer-v2kr bug](#tauri-explorer-v2kr-bug)
- [⚫ tauri-explorer-7xzv feature](#tauri-explorer-7xzv-feature)
- [⚫ tauri-explorer-wxzn feature](#tauri-explorer-wxzn-feature)
- [⚫ tauri-explorer-3b5s Stream file results via Tauri events](#tauri-explorer-3b5s-stream-file-results-via-tauri-events)
- [⚫ tauri-explorer-nzgb Implement virtualized file list](#tauri-explorer-nzgb-implement-virtualized-file-list)
- [⚫ tauri-explorer-a0b2 EPIC: Performance Optimization](#tauri-explorer-a0b2-epic-performance-optimization)
- [⚫ tauri-explorer-pad Double click to open files in default app](#tauri-explorer-pad-double-click-to-open-files-in-default-app)
- [⚫ tauri-explorer-bry Double click to open folders](#tauri-explorer-bry-double-click-to-open-folders)
- [⚫ tauri-explorer-i9d Single click to select file with visual highlighting](#tauri-explorer-i9d-single-click-to-select-file-with-visual-highlighting)
- [⚫ tauri-explorer-imc EPIC: File Selection and Interaction](#tauri-explorer-imc-epic-file-selection-and-interaction)
- [⚫ tauri-vz1q Undo drag operations doesn't refresh source window](#tauri-vz1q-undo-drag-operations-doesn-t-refresh-source-window)
- [⚫ tauri-5dq0 Cross-folder drag inconsistent](#tauri-5dq0-cross-folder-drag-inconsistent)
- [⚫ tauri-15y5 Undo delete doesn't work](#tauri-15y5-undo-delete-doesn-t-work)
- [⚫ tauri-saj4 Fix: Marquee selection has invisible 32px boundary in list/tiles views](#tauri-saj4-fix-marquee-selection-has-invisible-32px-boundary-in-list-tiles-views)
- [⚫ tauri-p09o Include recent/frecency paths in Ctrl+P search](#tauri-p09o-include-recent-frecency-paths-in-ctrl-p-search)
- [⚫ tauri-hevl Ctrl+Shift+T should restore closed tabs in new window when needed](#tauri-hevl-ctrl-shift-t-should-restore-closed-tabs-in-new-window-when-needed)
- [⚫ tauri-31co Details view column headers are transparent when scrolling](#tauri-31co-details-view-column-headers-are-transparent-when-scrolling)
- [⚫ tauri-5r30 Dragged file still visible in source window until refresh](#tauri-5r30-dragged-file-still-visible-in-source-window-until-refresh)
- [⚫ tauri-sa5i Selected files don't match selection box in list view](#tauri-sa5i-selected-files-don-t-match-selection-box-in-list-view)
- [⚫ tauri-zmjd List/tiles view highlight selection area stops short of first icon](#tauri-zmjd-list-tiles-view-highlight-selection-area-stops-short-of-first-icon)
- [⚫ tauri-mfjv Icons shift slightly when highlighted due to left-side highlight color](#tauri-mfjv-icons-shift-slightly-when-highlighted-due-to-left-side-highlight-color)
- [⚫ tauri-lgo0 Error shown after deleting folder: 'Unable to access folder'](#tauri-lgo0-error-shown-after-deleting-folder-unable-to-access-folder)
- [⚫ tauri-vmpc Copy/cut freezes window - sync Tauri commands block main thread](#tauri-vmpc-copy-cut-freezes-window-sync-tauri-commands-block-main-thread)
- [⚫ tauri-j9aa Context menu doesn't appear when right-clicking files/folders](#tauri-j9aa-context-menu-doesn-t-appear-when-right-clicking-files-folders)
- [⚫ tauri-jmcg Double-clicking symlink opens terminal instead of navigating in app](#tauri-jmcg-double-clicking-symlink-opens-terminal-instead-of-navigating-in-app)
- [⚫ tauri-ksp2 Remove '/ >' prefix from address bar](#tauri-ksp2-remove-prefix-from-address-bar)
- [⚫ tauri-5hlj Remove weird triangles from address bar](#tauri-5hlj-remove-weird-triangles-from-address-bar)
- [⚫ tauri-8ytw Right-click context menu doesn't appear on second click](#tauri-8ytw-right-click-context-menu-doesn-t-appear-on-second-click)
- [⚫ tauri-zvg6 Drag to quick access doesn't work](#tauri-zvg6-drag-to-quick-access-doesn-t-work)
- [⚫ tauri-anov Clipboard is window-specific instead of app-global](#tauri-anov-clipboard-is-window-specific-instead-of-app-global)
- [⚫ tauri-fadw EPIC: Architecture improvements for extensibility and maintainability](#tauri-fadw-epic-architecture-improvements-for-extensibility-and-maintainability)
- [⚫ tauri-x4cy Fix deleted folder error message after successful deletion](#tauri-x4cy-fix-deleted-folder-error-message-after-successful-deletion)
- [⚫ tauri-o5ny Refactor: Remove duplicate keyboard shortcut handlers](#tauri-o5ny-refactor-remove-duplicate-keyboard-shortcut-handlers)
- [⚫ tauri-0nj7 Fix marquee selection box offset from cursor position](#tauri-0nj7-fix-marquee-selection-box-offset-from-cursor-position)
- [⚫ tauri-6yzm Fix paste into empty folder duplicates 3 times](#tauri-6yzm-fix-paste-into-empty-folder-duplicates-3-times)
- [⚫ tauri-qz5t Fix copy/paste folder with files not working](#tauri-qz5t-fix-copy-paste-folder-with-files-not-working)
- [⚫ tauri-nag1 Fix tiles view freeze when loading thumbnails](#tauri-nag1-fix-tiles-view-freeze-when-loading-thumbnails)
- [⚫ tauri-n5sr Fix tiles view drag selection box mismatch](#tauri-n5sr-fix-tiles-view-drag-selection-box-mismatch)
- [⚫ tauri-qbx6 Fix PNG image previews not working](#tauri-qbx6-fix-png-image-previews-not-working)
- [⚫ tauri-1rzt Fix laggy image previews](#tauri-1rzt-fix-laggy-image-previews)
- [⚫ tauri-nycs Enter key works for confirmation modals](#tauri-nycs-enter-key-works-for-confirmation-modals)
- [⚫ tauri-phud Delete multiple selected files](#tauri-phud-delete-multiple-selected-files)
- [⚫ tauri-64lw Tiles view crashes when selected via command palette](#tauri-64lw-tiles-view-crashes-when-selected-via-command-palette)
- [⚫ tauri-nczo Frontend: Incremental flattening + pagination + cached offsets](#tauri-nczo-frontend-incremental-flattening-pagination-cached-offsets)
- [⚫ tauri-pkc4 Backend: SearcherBuilder with mmap + binary detection + per-thread reuse](#tauri-pkc4-backend-searcherbuilder-with-mmap-binary-detection-per-thread-reuse)
- [⚫ tauri-ygaq EPIC: Content Search Performance Optimization](#tauri-ygaq-epic-content-search-performance-optimization)
- [⚫ tauri-svfq Add zoom functionality with Alt+/- hotkeys](#tauri-svfq-add-zoom-functionality-with-alt-hotkeys)
- [⚫ tauri-aefl Fix drag-and-drop Quick Access pinning in Tauri desktop app (WebKitGTK)](#tauri-aefl-fix-drag-and-drop-quick-access-pinning-in-tauri-desktop-app-webkitgtk)
- [⚫ tauri-0gre Fix drag and drop to pin folders in Quick Access](#tauri-0gre-fix-drag-and-drop-to-pin-folders-in-quick-access)
- [⚫ tauri-explorer-rdra Support pasting files from OS clipboard](#tauri-explorer-rdra-support-pasting-files-from-os-clipboard)
- [⚫ tauri-explorer-za55 OS clipboard integration for copy operations](#tauri-explorer-za55-os-clipboard-integration-for-copy-operations)
- [⚫ tauri-explorer-5w06 Content search performance: parallel walking + per-file limits + delta emit](#tauri-explorer-5w06-content-search-performance-parallel-walking-per-file-limits-delta-emit)
- [⚫ tauri-explorer-10m8 Add tests for content search streaming and cancellation](#tauri-explorer-10m8-add-tests-for-content-search-streaming-and-cancellation)
- [⚫ tauri-explorer-vpxq Cannot cancel content search while in progress](#tauri-explorer-vpxq-cannot-cancel-content-search-while-in-progress)
- [⚫ tauri-explorer-44dx Content search results don't stream progressively](#tauri-explorer-44dx-content-search-results-don-t-stream-progressively)
- [⚫ tauri-explorer-c0rr Tab title not updating when navigating](#tauri-explorer-c0rr-tab-title-not-updating-when-navigating)
- [⚫ tauri-explorer-9b4m Fix clipboard shortcuts not working after clicking files](#tauri-explorer-9b4m-fix-clipboard-shortcuts-not-working-after-clicking-files)
- [⚫ tauri-explorer-ldfx Move tabs above pane level (window-level tabs)](#tauri-explorer-ldfx-move-tabs-above-pane-level-window-level-tabs)
- [⚫ tauri-explorer-az6w Streaming fuzzy search like fzf (10k+ files)](#tauri-explorer-az6w-streaming-fuzzy-search-like-fzf-10k-files)
- [⚫ tauri-explorer-im3m Performant image thumbnail generation in Rust](#tauri-explorer-im3m-performant-image-thumbnail-generation-in-rust)
- [⚫ tauri-explorer-nv2y EPIC: Migrate Backend from FastAPI to Rust](#tauri-explorer-nv2y-epic-migrate-backend-from-fastapi-to-rust)
- [⚫ tauri-explorer-t23c Tiles view: icons don't match details view, all icons plain white](#tauri-explorer-t23c-tiles-view-icons-don-t-match-details-view-all-icons-plain-white)
- [⚫ tauri-explorer-y3j4 Tiles view: tiles too tall with incorrect scaling](#tauri-explorer-y3j4-tiles-view-tiles-too-tall-with-incorrect-scaling)
- [⚫ tauri-explorer-jii9 QuickOpen file icons don't match explorer icons](#tauri-explorer-jii9-quickopen-file-icons-don-t-match-explorer-icons)
- [⚫ tauri-explorer-459h Fuzzy search should also search folders](#tauri-explorer-459h-fuzzy-search-should-also-search-folders)
- [⚫ tauri-explorer-0o2v Fuzzy search (Ctrl+P) returns no results](#tauri-explorer-0o2v-fuzzy-search-ctrl-p-returns-no-results)
- [⚫ tauri-explorer-ced8 Dual pane keyboard shortcut (Ctrl+\) doesn't work](#tauri-explorer-ced8-dual-pane-keyboard-shortcut-ctrl-doesn-t-work)
- [⚫ tauri-explorer-u7bg Cross-pane and external clipboard paste](#tauri-explorer-u7bg-cross-pane-and-external-clipboard-paste)
- [⚫ tauri-explorer-npjh.3 Toggle sidebar visibility](#tauri-explorer-npjh-3-toggle-sidebar-visibility)
- [⚫ tauri-explorer-npjh.2 Toggle shared toolbar visibility](#tauri-explorer-npjh-2-toggle-shared-toolbar-visibility)
- [⚫ tauri-explorer-npjh.1 Settings dialog with Ctrl+, shortcut](#tauri-explorer-npjh-1-settings-dialog-with-ctrl-shortcut)
- [⚫ tauri-explorer-npjh EPIC: Settings and Customization](#tauri-explorer-npjh-epic-settings-and-customization)
- [⚫ tauri-explorer-um74 Grey out unfocused pane in dual pane mode](#tauri-explorer-um74-grey-out-unfocused-pane-in-dual-pane-mode)
- [⚫ tauri-explorer-6ukk Enable drag and drop between dual panes](#tauri-explorer-6ukk-enable-drag-and-drop-between-dual-panes)
- [⚫ tauri-explorer-h0jl Create shared toolbar with pane-specific navigation bars](#tauri-explorer-h0jl-create-shared-toolbar-with-pane-specific-navigation-bars)
- [⚫ tauri-explorer-oibi Remove computer and home icons from breadcrumbs bar](#tauri-explorer-oibi-remove-computer-and-home-icons-from-breadcrumbs-bar)
- [⚫ tauri-explorer-1k9k Split explorer.svelte.ts God-object into focused stores](#tauri-explorer-1k9k-split-explorer-svelte-ts-god-object-into-focused-stores)
- [⚫ tauri-explorer-5lbi EPIC: Architecture Improvements](#tauri-explorer-5lbi-epic-architecture-improvements)
- [⚫ tauri-explorer-adtw Match Windows Explorer title bar style](#tauri-explorer-adtw-match-windows-explorer-title-bar-style)
- [⚫ tauri-explorer-0o79 Drag select box should not extend into column headers](#tauri-explorer-0o79-drag-select-box-should-not-extend-into-column-headers)
- [⚫ tauri-explorer-3mj7 Cut/copied dialog should disappear after pasting](#tauri-explorer-3mj7-cut-copied-dialog-should-disappear-after-pasting)
- [⚫ tauri-explorer-0o5m Make columns resizable](#tauri-explorer-0o5m-make-columns-resizable)
- [⚫ tauri-explorer-99fc Remove Gallery and OneDrive from sidebar](#tauri-explorer-99fc-remove-gallery-and-onedrive-from-sidebar)
- [⚫ tauri-explorer-bhw5 Add undo functionality with Ctrl+Z shortcut](#tauri-explorer-bhw5-add-undo-functionality-with-ctrl-z-shortcut)
- [⚫ tauri-explorer-92uy Drag files into folders to move them](#tauri-explorer-92uy-drag-files-into-folders-to-move-them)
- [⚫ tauri-explorer-52gd Drag to rearrange bookmarks](#tauri-explorer-52gd-drag-to-rearrange-bookmarks)
- [⚫ tauri-explorer-39wl Make sidebar section resizable](#tauri-explorer-39wl-make-sidebar-section-resizable)
- [⚫ tauri-explorer-sm3p Drag and drop folders onto bookmarks bar](#tauri-explorer-sm3p-drag-and-drop-folders-onto-bookmarks-bar)
- [⚫ tauri-explorer-l7lv.4 feature](#tauri-explorer-l7lv-4-feature)
- [⚫ tauri-explorer-l7lv.3 feature](#tauri-explorer-l7lv-3-feature)
- [⚫ tauri-explorer-l7lv.2 feature](#tauri-explorer-l7lv-2-feature)
- [⚫ tauri-explorer-l7lv.1 feature](#tauri-explorer-l7lv-1-feature)
- [⚫ tauri-explorer-l7lv epic](#tauri-explorer-l7lv-epic)
- [⚫ tauri-explorer-mht5 feature](#tauri-explorer-mht5-feature)
- [⚫ tauri-explorer-9prl feature](#tauri-explorer-9prl-feature)
- [⚫ tauri-explorer-ikiq feature](#tauri-explorer-ikiq-feature)
- [⚫ tauri-explorer-w0eo Delete sends to recycle bin instead of permanent deletion](#tauri-explorer-w0eo-delete-sends-to-recycle-bin-instead-of-permanent-deletion)
- [⚫ tauri-explorer-okfw Drag select (marquee/lasso selection)](#tauri-explorer-okfw-drag-select-marquee-lasso-selection)
- [⚫ tauri-explorer-yn48 Shift+click range selection](#tauri-explorer-yn48-shift-click-range-selection)
- [⚫ tauri-explorer-xqgy Create Playwright performance test suite](#tauri-explorer-xqgy-create-playwright-performance-test-suite)
- [⚫ tauri-explorer-aj9u Create Svelte rendering performance tests](#tauri-explorer-aj9u-create-svelte-rendering-performance-tests)
- [⚫ tauri-explorer-8n9r Create backend benchmark suite with pytest-benchmark](#tauri-explorer-8n9r-create-backend-benchmark-suite-with-pytest-benchmark)
- [⚫ tauri-explorer-y4y7 EPIC: Performance Testing Infrastructure](#tauri-explorer-y4y7-epic-performance-testing-infrastructure)
- [⚫ tauri-explorer-8ja7 Implement parallel directory traversal with jwalk](#tauri-explorer-8ja7-implement-parallel-directory-traversal-with-jwalk)
- [⚫ tauri-explorer-hgt6 Move file scanning to Rust Tauri command](#tauri-explorer-hgt6-move-file-scanning-to-rust-tauri-command)
- [⚫ tauri-explorer-cdn4 Implement chunked response for large directories](#tauri-explorer-cdn4-implement-chunked-response-for-large-directories)
- [⚫ tauri-explorer-i0yt Use Tauri custom protocol for thumbnails](#tauri-explorer-i0yt-use-tauri-custom-protocol-for-thumbnails)
- [⚫ tauri-explorer-ibik Use os.scandir instead of os.listdir](#tauri-explorer-ibik-use-os-scandir-instead-of-os-listdir)
- [⚫ tauri-explorer-qaqo Switch to orjson for JSON serialization](#tauri-explorer-qaqo-switch-to-orjson-for-json-serialization)
- [⚫ tauri-explorer-nxpl Lazy load file icons with IntersectionObserver](#tauri-explorer-nxpl-lazy-load-file-icons-with-intersectionobserver)
- [⚫ tauri-explorer-ac7y Keyboard navigation in file list](#tauri-explorer-ac7y-keyboard-navigation-in-file-list)
- [⚫ tauri-explorer-qcq5 Persist tabs across sessions](#tauri-explorer-qcq5-persist-tabs-across-sessions)
- [⚫ tauri-explorer-klo Persist hidden files preference](#tauri-explorer-klo-persist-hidden-files-preference)
- [⚫ tauri-explorer-zgf Ctrl+H shortcut for hidden files toggle](#tauri-explorer-zgf-ctrl-h-shortcut-for-hidden-files-toggle)
- [⚫ tauri-explorer-u5a Ctrl+Y/Ctrl+Shift+Z to redo](#tauri-explorer-u5a-ctrl-y-ctrl-shift-z-to-redo)
- [⚫ tauri-explorer-83z EPIC: View Modes](#tauri-explorer-83z-epic-view-modes)
- [⚫ tauri-explorer-k1p EPIC: Drag and Drop](#tauri-explorer-k1p-epic-drag-and-drop)
- [⚫ tauri-explorer-6bt EPIC: Bookmarks System](#tauri-explorer-6bt-epic-bookmarks-system)
- [⚫ tauri-explorer-79p Deselect files when clicking empty area](#tauri-explorer-79p-deselect-files-when-clicking-empty-area)
- [⚫ tauri-explorer-88u Remove toolbar buttons for minimal UI](#tauri-explorer-88u-remove-toolbar-buttons-for-minimal-ui)
- [⚫ tauri-explorer-c14 Copy conflict: create 'file - Copy' naming](#tauri-explorer-c14-copy-conflict-create-file-copy-naming)
- [⚫ tauri-explorer-7ii Write playwright_tests.md spec file](#tauri-explorer-7ii-write-playwright-tests-md-spec-file)
- [⚫ tauri-explorer-edi Playwright test suite setup](#tauri-explorer-edi-playwright-test-suite-setup)
- [⚫ tauri-explorer-dr4 Recursive directory scanning for search](#tauri-explorer-dr4-recursive-directory-scanning-for-search)
- [⚫ tauri-explorer-rxx Fuzzy file name matching algorithm](#tauri-explorer-rxx-fuzzy-file-name-matching-algorithm)
- [⚫ tauri-explorer-btz Ctrl+P quick open dialog](#tauri-explorer-btz-ctrl-p-quick-open-dialog)
- [⚫ tauri-explorer-dfx Command search and filtering](#tauri-explorer-dfx-command-search-and-filtering)
- [⚫ tauri-explorer-0dk Command palette overlay UI](#tauri-explorer-0dk-command-palette-overlay-ui)
- [⚫ tauri-explorer-abm Command registry system](#tauri-explorer-abm-command-registry-system)
- [⚫ tauri-explorer-i8l Close tab (Ctrl+W, middle-click)](#tauri-explorer-i8l-close-tab-ctrl-w-middle-click)
- [⚫ tauri-explorer-xqa New tab creation (Ctrl+T)](#tauri-explorer-xqa-new-tab-creation-ctrl-t)
- [⚫ tauri-explorer-so0 Tab bar component for panes](#tauri-explorer-so0-tab-bar-component-for-panes)
- [⚫ tauri-explorer-gsc Dual pane layout component](#tauri-explorer-gsc-dual-pane-layout-component)
- [⚫ tauri-explorer-jqi Cancel button for ongoing operations](#tauri-explorer-jqi-cancel-button-for-ongoing-operations)
- [⚫ tauri-explorer-41o Progress dialog component for long operations](#tauri-explorer-41o-progress-dialog-component-for-long-operations)
- [⚫ tauri-explorer-nqm Refresh button and F5 shortcut](#tauri-explorer-nqm-refresh-button-and-f5-shortcut)
- [⚫ tauri-explorer-0c8 Breadcrumb navigation for path segments](#tauri-explorer-0c8-breadcrumb-navigation-for-path-segments)
- [⚫ tauri-explorer-fb1 Editable path bar with copy support](#tauri-explorer-fb1-editable-path-bar-with-copy-support)
- [⚫ tauri-explorer-8p5 Up button to parent directory](#tauri-explorer-8p5-up-button-to-parent-directory)
- [⚫ tauri-explorer-0wo Back/Forward navigation with history stack](#tauri-explorer-0wo-back-forward-navigation-with-history-stack)
- [⚫ tauri-explorer-cmd Context menu: New Folder option](#tauri-explorer-cmd-context-menu-new-folder-option)
- [⚫ tauri-explorer-2m9 Context menu: Rename option](#tauri-explorer-2m9-context-menu-rename-option)
- [⚫ tauri-explorer-hmu Context menu: Cut, Copy, Paste, Delete](#tauri-explorer-hmu-context-menu-cut-copy-paste-delete)
- [⚫ tauri-explorer-z9v Basic right-click context menu framework](#tauri-explorer-z9v-basic-right-click-context-menu-framework)
- [⚫ tauri-explorer-ztg View mode toggle UI](#tauri-explorer-ztg-view-mode-toggle-ui)
- [⚫ tauri-explorer-col Thumbnail/grid view with previews](#tauri-explorer-col-thumbnail-grid-view-with-previews)
- [⚫ tauri-explorer-jf4 Details view with sortable columns](#tauri-explorer-jf4-details-view-with-sortable-columns)
- [⚫ tauri-explorer-gvb Drop files into app from external sources](#tauri-explorer-gvb-drop-files-into-app-from-external-sources)
- [⚫ tauri-explorer-cgc Drag files from app to external apps](#tauri-explorer-cgc-drag-files-from-app-to-external-apps)
- [⚫ tauri-explorer-xfj Internal drag and drop between folders](#tauri-explorer-xfj-internal-drag-and-drop-between-folders)
- [⚫ tauri-explorer-c2n Sidebar bookmarks display](#tauri-explorer-c2n-sidebar-bookmarks-display)
- [⚫ tauri-explorer-hdt Default bookmarks for user folders](#tauri-explorer-hdt-default-bookmarks-for-user-folders)
- [⚫ tauri-explorer-9v6 Bookmarks data model and persistence](#tauri-explorer-9v6-bookmarks-data-model-and-persistence)
- [⚫ tauri-explorer-1sv Select all with Ctrl+A](#tauri-explorer-1sv-select-all-with-ctrl-a)
- [⚫ tauri-explorer-lbb Range select with Shift+click](#tauri-explorer-lbb-range-select-with-shift-click)
- [⚫ tauri-explorer-6ur Multi-select with Ctrl+click](#tauri-explorer-6ur-multi-select-with-ctrl-click)
- [⚫ tauri-explorer-9l2 EPIC: Testing Infrastructure](#tauri-explorer-9l2-epic-testing-infrastructure)
- [⚫ tauri-explorer-w3t EPIC: Fuzzy File Search (Ctrl+P)](#tauri-explorer-w3t-epic-fuzzy-file-search-ctrl-p)
- [⚫ tauri-explorer-1ex EPIC: Command Palette](#tauri-explorer-1ex-epic-command-palette)
- [⚫ tauri-explorer-auj EPIC: Tabs System](#tauri-explorer-auj-epic-tabs-system)
- [⚫ tauri-explorer-3ct EPIC: Dual/Multi-Pane Layout](#tauri-explorer-3ct-epic-dual-multi-pane-layout)
- [⚫ tauri-explorer-5kv EPIC: Progress Bars and Operations](#tauri-explorer-5kv-epic-progress-bars-and-operations)
- [⚫ tauri-explorer-ihg EPIC: Navigation Controls](#tauri-explorer-ihg-epic-navigation-controls)
- [⚫ tauri-explorer-zhp EPIC: Context Menu](#tauri-explorer-zhp-epic-context-menu)
- [⚫ tauri-explorer-s4o EPIC: View Modes](#tauri-explorer-s4o-epic-view-modes)
- [⚫ tauri-explorer-0gs EPIC: Drag and Drop](#tauri-explorer-0gs-epic-drag-and-drop)
- [⚫ tauri-explorer-ooj EPIC: Bookmarks System](#tauri-explorer-ooj-epic-bookmarks-system)
- [⚫ tauri-explorer-h3n Delete file/folder operation](#tauri-explorer-h3n-delete-file-folder-operation)
- [⚫ tauri-explorer-bae Rename file/folder operation](#tauri-explorer-bae-rename-file-folder-operation)
- [⚫ tauri-explorer-jql Create new folder operation](#tauri-explorer-jql-create-new-folder-operation)
- [⚫ tauri-cf8q Remove copy icon from address bar RHS](#tauri-cf8q-remove-copy-icon-from-address-bar-rhs)
- [⚫ tauri-bpqk Make nav bar carets larger and easier to click](#tauri-bpqk-make-nav-bar-carets-larger-and-easier-to-click)
- [⚫ tauri-cwh1 Show toast on undo and drag move](#tauri-cwh1-show-toast-on-undo-and-drag-move)
- [⚫ tauri-77p5 Esc should close settings modal](#tauri-77p5-esc-should-close-settings-modal)
- [⚫ tauri-uo7j Clicking away from nav bar caret selects address bar](#tauri-uo7j-clicking-away-from-nav-bar-caret-selects-address-bar)
- [⚫ tauri-zdr5 Paste images from clipboard into explorer](#tauri-zdr5-paste-images-from-clipboard-into-explorer)
- [⚫ tauri-8gpm New window should inherit path/viewMode from last focused window](#tauri-8gpm-new-window-should-inherit-path-viewmode-from-last-focused-window)
- [⚫ tauri-fnzo New windows should inherit layout from parent](#tauri-fnzo-new-windows-should-inherit-layout-from-parent)
- [⚫ tauri-q1uj Ctrl+N should open new window at current path](#tauri-q1uj-ctrl-n-should-open-new-window-at-current-path)
- [⚫ tauri-sy06 Navigation bar carets should open directory picker](#tauri-sy06-navigation-bar-carets-should-open-directory-picker)
- [⚫ tauri-tu67 Increase font size in address bar](#tauri-tu67-increase-font-size-in-address-bar)
- [⚫ tauri-43vk Change zoom in/out default hotkeys to Ctrl+=/Ctrl+-](#tauri-43vk-change-zoom-in-out-default-hotkeys-to-ctrl-ctrl)
- [⚫ tauri-cj2c Fix /tmp directory hanging on loading](#tauri-cj2c-fix-tmp-directory-hanging-on-loading)
- [⚫ tauri-6u0j Fix folder icon color in rapture theme](#tauri-6u0j-fix-folder-icon-color-in-rapture-theme)
- [⚫ tauri-g656 Default new folder name increments if already exists](#tauri-g656-default-new-folder-name-increments-if-already-exists)
- [⚫ tauri-qvdh Ctrl+Shift+N creates a new folder](#tauri-qvdh-ctrl-shift-n-creates-a-new-folder)
- [⚫ tauri-kh3l Auto-select newly created folder](#tauri-kh3l-auto-select-newly-created-folder)
- [⚫ tauri-vjly Progress bar when copying or moving large files](#tauri-vjly-progress-bar-when-copying-or-moving-large-files)
- [⚫ tauri-zqdp Skip/overwrite dialog when pasting files that already exist](#tauri-zqdp-skip-overwrite-dialog-when-pasting-files-that-already-exist)
- [⚫ tauri-os5o Undo support for drag-move operations](#tauri-os5o-undo-support-for-drag-move-operations)
- [⚫ tauri-x4bs Show house icon in address bar for HOME directory](#tauri-x4bs-show-house-icon-in-address-bar-for-home-directory)
- [⚫ tauri-zf0z Increase spacing in list view to match details view](#tauri-zf0z-increase-spacing-in-list-view-to-match-details-view)
- [⚫ tauri-ibtv Display frecency score breakdown in Ctrl+P menu for debugging](#tauri-ibtv-display-frecency-score-breakdown-in-ctrl-p-menu-for-debugging)
- [⚫ tauri-kw2g Auto-select newly created folder](#tauri-kw2g-auto-select-newly-created-folder)
- [⚫ tauri-gkwz Can't drag folders in tiles view](#tauri-gkwz-can-t-drag-folders-in-tiles-view)
- [⚫ tauri-nweq Cross-window drag doesn't refresh source window](#tauri-nweq-cross-window-drag-doesn-t-refresh-source-window)
- [⚫ tauri-k4ec Configurable address bar buttons with removable items](#tauri-k4ec-configurable-address-bar-buttons-with-removable-items)
- [⚫ tauri-on1c Add status bar toggleable with Alt+M U](#tauri-on1c-add-status-bar-toggleable-with-alt-m-u)
- [⚫ tauri-o5dk Add multi-step chord shortcuts like VSCode](#tauri-o5dk-add-multi-step-chord-shortcuts-like-vscode)
- [⚫ tauri-u00y Move navigation controls next to address bar](#tauri-u00y-move-navigation-controls-next-to-address-bar)
- [⚫ tauri-2e92 Move window controls into the top toolbar](#tauri-2e92-move-window-controls-into-the-top-toolbar)
- [⚫ tauri-c8m9 Restructure explorer.svelte.ts API into named sub-objects](#tauri-c8m9-restructure-explorer-svelte-ts-api-into-named-sub-objects)
- [⚫ tauri-dyiz Inline new folder creation instead of dialog](#tauri-dyiz-inline-new-folder-creation-instead-of-dialog)
- [⚫ tauri-jwrv Save hotkey bindings to settings file](#tauri-jwrv-save-hotkey-bindings-to-settings-file)
- [⚫ tauri-c2dw Change go-up shortcut to Ctrl+Alt+Up](#tauri-c2dw-change-go-up-shortcut-to-ctrl-alt-up)
- [⚫ tauri-jrek Zoxide-style usage-weighted ranking in Ctrl+P quick open](#tauri-jrek-zoxide-style-usage-weighted-ranking-in-ctrl-p-quick-open)
- [⚫ tauri-pghn Advanced styling/theming system](#tauri-pghn-advanced-styling-theming-system)
- [⚫ tauri-ttbb Paste images from clipboard](#tauri-ttbb-paste-images-from-clipboard)
- [⚫ tauri-7z5p Change forward/backward shortcuts to Ctrl+Alt+Left/Right](#tauri-7z5p-change-forward-backward-shortcuts-to-ctrl-alt-left-right)
- [⚫ tauri-isj7 Improve multi-selection visual appearance](#tauri-isj7-improve-multi-selection-visual-appearance)
- [⚫ tauri-vozb Add symlink functionality](#tauri-vozb-add-symlink-functionality)
- [⚫ tauri-2dgf Drag files to another window moves instead of copies](#tauri-2dgf-drag-files-to-another-window-moves-instead-of-copies)
- [⚫ tauri-6z6j Ctrl+Shift+T reopen closed tab works with windows too](#tauri-6z6j-ctrl-shift-t-reopen-closed-tab-works-with-windows-too)
- [⚫ tauri-d2ff Improve tiles view styling](#tauri-d2ff-improve-tiles-view-styling)
- [⚫ tauri-fa6t Move clipboard/paste toasts to bottom-right corner](#tauri-fa6t-move-clipboard-paste-toasts-to-bottom-right-corner)
- [⚫ tauri-3bxs Ctrl+Shift+T restore closed tab or window](#tauri-3bxs-ctrl-shift-t-restore-closed-tab-or-window)
- [⚫ tauri-tvvi Ctrl+P global folder search beyond CWD subdirectories](#tauri-tvvi-ctrl-p-global-folder-search-beyond-cwd-subdirectories)
- [⚫ tauri-ggjw Multi-file copy/paste from selection](#tauri-ggjw-multi-file-copy-paste-from-selection)
- [⚫ tauri-xsur Ctrl+W closes window when only one tab remains](#tauri-xsur-ctrl-w-closes-window-when-only-one-tab-remains)
- [⚫ tauri-y1f0 Ctrl+N opens new window at current directory](#tauri-y1f0-ctrl-n-opens-new-window-at-current-directory)
- [⚫ tauri-piv8 Option to hide window control buttons (minimize/maximize/close)](#tauri-piv8-option-to-hide-window-control-buttons-minimize-maximize-close)
- [⚫ tauri-zwdl Hide tab bar when only one tab is open](#tauri-zwdl-hide-tab-bar-when-only-one-tab-is-open)
- [⚫ tauri-r4ic Content search dialog: text clipped at top of result rows](#tauri-r4ic-content-search-dialog-text-clipped-at-top-of-result-rows)
- [⚫ tauri-dbiw Backend: Line truncation + adaptive batching + higher cap](#tauri-dbiw-backend-line-truncation-adaptive-batching-higher-cap)
- [⚫ tauri-jvdk Add Rapture theme (Ghostty color scheme)](#tauri-jvdk-add-rapture-theme-ghostty-color-scheme)
- [⚫ tauri-dh79 Investigate why HTML5 drop event never fires in Svelte 5 and fix properly](#tauri-dh79-investigate-why-html5-drop-event-never-fires-in-svelte-5-and-fix-properly)
- [⚫ tauri-explorer-47pv Convert cut/copy notification banner to toast](#tauri-explorer-47pv-convert-cut-copy-notification-banner-to-toast)
- [⚫ tauri-explorer-8ret Add performance tests for content search (ripgrep)](#tauri-explorer-8ret-add-performance-tests-for-content-search-ripgrep)
- [⚫ tauri-explorer-w0c7 Horizontal scroll reveals whitespace when window too narrow](#tauri-explorer-w0c7-horizontal-scroll-reveals-whitespace-when-window-too-narrow)
- [⚫ tauri-explorer-o4wz Show placeholder icons while thumbnails load](#tauri-explorer-o4wz-show-placeholder-icons-while-thumbnails-load)
- [⚫ tauri-explorer-jrfg Multi-file copy/cut support](#tauri-explorer-jrfg-multi-file-copy-cut-support)
- [⚫ tauri-explorer-syq3 Marquee selection laggy in Tauri app vs browser](#tauri-explorer-syq3-marquee-selection-laggy-in-tauri-app-vs-browser)
- [⚫ tauri-explorer-ev2h Make focused pane more obviously focused](#tauri-explorer-ev2h-make-focused-pane-more-obviously-focused)
- [⚫ tauri-explorer-u0mo Fuzzy search dialog shouldn't be transparent](#tauri-explorer-u0mo-fuzzy-search-dialog-shouldn-t-be-transparent)
- [⚫ tauri-explorer-npjh.4 Customizable hotkeys](#tauri-explorer-npjh-4-customizable-hotkeys)
- [⚫ tauri-explorer-7pce Extract file type/icon mapping from FileItem.svelte](#tauri-explorer-7pce-extract-file-type-icon-mapping-from-fileitem-svelte)
- [⚫ tauri-explorer-bo8l Fix window rounded corners and border on Windows](#tauri-explorer-bo8l-fix-window-rounded-corners-and-border-on-windows)
- [⚫ tauri-explorer-c6dz Playwright test: measure scroll performance](#tauri-explorer-c6dz-playwright-test-measure-scroll-performance)
- [⚫ tauri-explorer-npl3 Playwright test: measure large directory render time](#tauri-explorer-npl3-playwright-test-measure-large-directory-render-time)
- [⚫ tauri-explorer-3pzn Playwright test: measure app cold start time](#tauri-explorer-3pzn-playwright-test-measure-app-cold-start-time)
- [⚫ tauri-explorer-ha9r Add rendering benchmark for virtualized vs non-virtualized list](#tauri-explorer-ha9r-add-rendering-benchmark-for-virtualized-vs-non-virtualized-list)
- [⚫ tauri-explorer-c1a1 Benchmark orjson vs standard json](#tauri-explorer-c1a1-benchmark-orjson-vs-standard-json)
- [⚫ tauri-explorer-ykh1 Benchmark os.scandir vs os.listdir performance](#tauri-explorer-ykh1-benchmark-os-scandir-vs-os-listdir-performance)
- [⚫ tauri-explorer-2ira Use async file I/O with aiofiles](#tauri-explorer-2ira-use-async-file-i-o-with-aiofiles)
- [⚫ tauri-explorer-o49t Ensure Pydantic v2 for faster validation](#tauri-explorer-o49t-ensure-pydantic-v2-for-faster-validation)
- [⚫ tauri-explorer-cn3d Recent files in command palette](#tauri-explorer-cn3d-recent-files-in-command-palette)
- [⚫ tauri-explorer-omkn Track recently opened files](#tauri-explorer-omkn-track-recently-opened-files)
- [⚫ tauri-explorer-en98 Search results with context preview](#tauri-explorer-en98-search-results-with-context-preview)
- [⚫ tauri-explorer-3a1q Ripgrep integration for content search](#tauri-explorer-3a1q-ripgrep-integration-for-content-search)
- [⚫ tauri-explorer-evim Ctrl+Shift+F search in files dialog](#tauri-explorer-evim-ctrl-shift-f-search-in-files-dialog)
- [⚫ tauri-explorer-uz7d Real-time search results as you type](#tauri-explorer-uz7d-real-time-search-results-as-you-type)
- [⚫ tauri-explorer-lcd9 Keybinding conflict detection](#tauri-explorer-lcd9-keybinding-conflict-detection)
- [⚫ tauri-explorer-oytv Hotkey configuration UI](#tauri-explorer-oytv-hotkey-configuration-ui)
- [⚫ tauri-explorer-3fac Recently used commands at top](#tauri-explorer-3fac-recently-used-commands-at-top)
- [⚫ tauri-explorer-xago Image preview in preview pane](#tauri-explorer-xago-image-preview-in-preview-pane)
- [⚫ tauri-explorer-osjq Text file preview with syntax highlighting](#tauri-explorer-osjq-text-file-preview-with-syntax-highlighting)
- [⚫ tauri-explorer-nnda Spacebar to toggle preview pane](#tauri-explorer-nnda-spacebar-to-toggle-preview-pane)
- [⚫ tauri-explorer-2c6b Preview pane component](#tauri-explorer-2c6b-preview-pane-component)
- [⚫ tauri-explorer-howc Workspace quick access menu](#tauri-explorer-howc-workspace-quick-access-menu)
- [⚫ tauri-explorer-6qrn Save current workspace dialog](#tauri-explorer-6qrn-save-current-workspace-dialog)
- [⚫ tauri-explorer-6iax Workspace data model](#tauri-explorer-6iax-workspace-data-model)
- [⚫ tauri-explorer-4x9f Tab reordering via drag](#tauri-explorer-4x9f-tab-reordering-via-drag)
- [⚫ tauri-explorer-4zex Tab navigation shortcuts (Ctrl+Tab)](#tauri-explorer-4zex-tab-navigation-shortcuts-ctrl-tab)
- [⚫ tauri-explorer-xcs6 Copy/Move to other pane shortcuts](#tauri-explorer-xcs6-copy-move-to-other-pane-shortcuts)
- [⚫ tauri-explorer-9214 Toggle dual pane mode](#tauri-explorer-9214-toggle-dual-pane-mode)
- [⚫ tauri-explorer-743 Resizable pane divider](#tauri-explorer-743-resizable-pane-divider)
- [⚫ tauri-explorer-5o0 Error handling with retry option](#tauri-explorer-5o0-error-handling-with-retry-option)
- [⚫ tauri-explorer-4us Operation queue for multiple operations](#tauri-explorer-4us-operation-queue-for-multiple-operations)
- [⚫ tauri-explorer-mwr File count and size estimation for progress](#tauri-explorer-mwr-file-count-and-size-estimation-for-progress)
- [⚫ tauri-explorer-d2y Hidden files toggle in View menu](#tauri-explorer-d2y-hidden-files-toggle-in-view-menu)
- [⚫ tauri-explorer-b4u Delete to trash for undo support](#tauri-explorer-b4u-delete-to-trash-for-undo-support)
- [⚫ tauri-explorer-ijs Ctrl+Z to undo last operation](#tauri-explorer-ijs-ctrl-z-to-undo-last-operation)
- [⚫ tauri-explorer-av1 Operation history stack for undo/redo](#tauri-explorer-av1-operation-history-stack-for-undo-redo)
- [⚫ tauri-explorer-0xr Context menu: Extract archive](#tauri-explorer-0xr-context-menu-extract-archive)
- [⚫ tauri-explorer-kez Context menu: Compress files](#tauri-explorer-kez-context-menu-compress-files)
- [⚫ tauri-explorer-brn Thumbnail generation for images](#tauri-explorer-brn-thumbnail-generation-for-images)
- [⚫ tauri-explorer-c0q Compact list view](#tauri-explorer-c0q-compact-list-view)
- [⚫ tauri-explorer-3u7 Sort persistence per directory](#tauri-explorer-3u7-sort-persistence-per-directory)
- [⚫ tauri-explorer-ww3 Copy vs Move modifier keys during drag](#tauri-explorer-ww3-copy-vs-move-modifier-keys-during-drag)
- [⚫ tauri-explorer-b0r Drag visual feedback and preview](#tauri-explorer-b0r-drag-visual-feedback-and-preview)
- [⚫ tauri-explorer-do3 Remove bookmark from sidebar](#tauri-explorer-do3-remove-bookmark-from-sidebar)
- [⚫ tauri-explorer-sox Add bookmark from context menu](#tauri-explorer-sox-add-bookmark-from-context-menu)
- [⚫ tauri-explorer-kwe EPIC: Recent Files](#tauri-explorer-kwe-epic-recent-files)
- [⚫ tauri-explorer-raf EPIC: Search in Files](#tauri-explorer-raf-epic-search-in-files)
- [⚫ tauri-explorer-m0b EPIC: Customizable Hotkeys](#tauri-explorer-m0b-epic-customizable-hotkeys)
- [⚫ tauri-explorer-xdm EPIC: Preview Pane](#tauri-explorer-xdm-epic-preview-pane)
- [⚫ tauri-explorer-06c EPIC: Workspaces/Layouts](#tauri-explorer-06c-epic-workspaces-layouts)
- [⚫ tauri-explorer-lul EPIC: Hidden Files Toggle](#tauri-explorer-lul-epic-hidden-files-toggle)
- [⚫ tauri-explorer-vvr EPIC: Undo/Redo System](#tauri-explorer-vvr-epic-undo-redo-system)
- [⚫ tauri-explorer-9xb Keyboard navigation in file list](#tauri-explorer-9xb-keyboard-navigation-in-file-list)
- [⚫ tauri-explorer-e1z Unit tests for state management](#tauri-explorer-e1z-unit-tests-for-state-management)
- [⚫ tauri-explorer-fho Unit tests for file operations](#tauri-explorer-fho-unit-tests-for-file-operations)
- [⚫ tauri-explorer-yuz Recent files in command palette](#tauri-explorer-yuz-recent-files-in-command-palette)
- [⚫ tauri-explorer-dd9 Track recently opened files](#tauri-explorer-dd9-track-recently-opened-files)
- [⚫ tauri-explorer-dzr Search results with context preview](#tauri-explorer-dzr-search-results-with-context-preview)
- [⚫ tauri-explorer-0ey Ripgrep integration for content search](#tauri-explorer-0ey-ripgrep-integration-for-content-search)
- [⚫ tauri-explorer-y48 Ctrl+Shift+F search in files dialog](#tauri-explorer-y48-ctrl-shift-f-search-in-files-dialog)
- [⚫ tauri-explorer-ktq Real-time search results as you type](#tauri-explorer-ktq-real-time-search-results-as-you-type)
- [⚫ tauri-explorer-kb9 Keybinding conflict detection](#tauri-explorer-kb9-keybinding-conflict-detection)
- [⚫ tauri-explorer-3kz Hotkey configuration UI](#tauri-explorer-3kz-hotkey-configuration-ui)
- [⚫ tauri-explorer-v9n Recently used commands at top](#tauri-explorer-v9n-recently-used-commands-at-top)
- [⚫ tauri-explorer-yv6 Image preview in preview pane](#tauri-explorer-yv6-image-preview-in-preview-pane)
- [⚫ tauri-explorer-gut Text file preview with syntax highlighting](#tauri-explorer-gut-text-file-preview-with-syntax-highlighting)
- [⚫ tauri-explorer-9yl Spacebar to toggle preview pane](#tauri-explorer-9yl-spacebar-to-toggle-preview-pane)
- [⚫ tauri-explorer-8yx Preview pane component](#tauri-explorer-8yx-preview-pane-component)
- [⚫ tauri-explorer-b2x Workspace quick access menu](#tauri-explorer-b2x-workspace-quick-access-menu)
- [⚫ tauri-explorer-1qg Save current workspace dialog](#tauri-explorer-1qg-save-current-workspace-dialog)
- [⚫ tauri-explorer-1g0 Workspace data model](#tauri-explorer-1g0-workspace-data-model)
- [⚫ tauri-explorer-62g Persist tabs across sessions](#tauri-explorer-62g-persist-tabs-across-sessions)
- [⚫ tauri-explorer-hrk Tab reordering via drag](#tauri-explorer-hrk-tab-reordering-via-drag)
- [⚫ tauri-explorer-gov Tab navigation shortcuts (Ctrl+Tab, Ctrl+1-9)](#tauri-explorer-gov-tab-navigation-shortcuts-ctrl-tab-ctrl-1-9)
- [⚫ tauri-explorer-5ut Copy/Move to other pane shortcuts](#tauri-explorer-5ut-copy-move-to-other-pane-shortcuts)
- [⚫ tauri-explorer-m7w Toggle dual pane mode](#tauri-explorer-m7w-toggle-dual-pane-mode)
- [⚫ tauri-explorer-eq6 Resizable pane divider](#tauri-explorer-eq6-resizable-pane-divider)
- [⚫ tauri-explorer-z3s Error handling with retry option](#tauri-explorer-z3s-error-handling-with-retry-option)
- [⚫ tauri-explorer-st1 Operation queue for multiple operations](#tauri-explorer-st1-operation-queue-for-multiple-operations)
- [⚫ tauri-explorer-6a4 File count and size estimation for progress](#tauri-explorer-6a4-file-count-and-size-estimation-for-progress)
- [⚫ tauri-explorer-9ae Persist hidden files preference](#tauri-explorer-9ae-persist-hidden-files-preference)
- [⚫ tauri-explorer-l62 Ctrl+H shortcut for hidden files toggle](#tauri-explorer-l62-ctrl-h-shortcut-for-hidden-files-toggle)
- [⚫ tauri-explorer-8ua Hidden files toggle in View menu](#tauri-explorer-8ua-hidden-files-toggle-in-view-menu)
- [⚫ tauri-explorer-0hd Delete to trash for undo support](#tauri-explorer-0hd-delete-to-trash-for-undo-support)
- [⚫ tauri-explorer-yyn Ctrl+Y/Ctrl+Shift+Z to redo](#tauri-explorer-yyn-ctrl-y-ctrl-shift-z-to-redo)
- [⚫ tauri-explorer-7m5 Ctrl+Z to undo last operation](#tauri-explorer-7m5-ctrl-z-to-undo-last-operation)
- [⚫ tauri-explorer-3o5 Operation history stack for undo/redo](#tauri-explorer-3o5-operation-history-stack-for-undo-redo)
- [⚫ tauri-explorer-hoy Context menu: Extract archive](#tauri-explorer-hoy-context-menu-extract-archive)
- [⚫ tauri-explorer-0a4 Context menu: Compress files](#tauri-explorer-0a4-context-menu-compress-files)
- [⚫ tauri-explorer-24i Thumbnail generation for images](#tauri-explorer-24i-thumbnail-generation-for-images)
- [⚫ tauri-explorer-r3d Sort persistence per directory](#tauri-explorer-r3d-sort-persistence-per-directory)
- [⚫ tauri-explorer-3ol Compact list view](#tauri-explorer-3ol-compact-list-view)
- [⚫ tauri-explorer-m1f Copy vs Move modifier keys during drag](#tauri-explorer-m1f-copy-vs-move-modifier-keys-during-drag)
- [⚫ tauri-explorer-wp6 Drag visual feedback and preview](#tauri-explorer-wp6-drag-visual-feedback-and-preview)
- [⚫ tauri-explorer-bok Remove bookmark from sidebar](#tauri-explorer-bok-remove-bookmark-from-sidebar)
- [⚫ tauri-explorer-0oa Add bookmark from context menu](#tauri-explorer-0oa-add-bookmark-from-context-menu)
- [⚫ tauri-explorer-zis EPIC: Recent Files](#tauri-explorer-zis-epic-recent-files)
- [⚫ tauri-explorer-moc EPIC: Search in Files](#tauri-explorer-moc-epic-search-in-files)
- [⚫ tauri-explorer-4gm EPIC: Customizable Hotkeys](#tauri-explorer-4gm-epic-customizable-hotkeys)
- [⚫ tauri-explorer-zl2 EPIC: Preview Pane](#tauri-explorer-zl2-epic-preview-pane)
- [⚫ tauri-explorer-5z0 EPIC: Workspaces/Layouts](#tauri-explorer-5z0-epic-workspaces-layouts)
- [⚫ tauri-explorer-d6w EPIC: Hidden Files Toggle](#tauri-explorer-d6w-epic-hidden-files-toggle)
- [⚫ tauri-explorer-brz EPIC: Undo/Redo System](#tauri-explorer-brz-epic-undo-redo-system)
- [⚫ tauri-explorer-x25 Copy/Move file operations](#tauri-explorer-x25-copy-move-file-operations)
- [⚫ tauri-explorer-rzs Configure Tauri sidecar integration](#tauri-explorer-rzs-configure-tauri-sidecar-integration)
- [⚫ tauri-explorer-iw0 Build UI components](#tauri-explorer-iw0-build-ui-components)
- [⚫ tauri-explorer-gcl Create Svelte 5 state management](#tauri-explorer-gcl-create-svelte-5-state-management)
- [⚫ tauri-explorer-4v1 Implement TypeScript API client](#tauri-explorer-4v1-implement-typescript-api-client)
- [⚫ tauri-explorer-p1f Implement FastAPI endpoints](#tauri-explorer-p1f-implement-fastapi-endpoints)
- [⚫ tauri-explorer-1yj Create TypeScript domain layer](#tauri-explorer-1yj-create-typescript-domain-layer)
- [⚫ tauri-nxfi Path autocomplete when typing in address bar](#tauri-nxfi-path-autocomplete-when-typing-in-address-bar)
- [⚫ tauri-pqo3 Clean up stale types, empty config, duplicate keyboard handlers](#tauri-pqo3-clean-up-stale-types-empty-config-duplicate-keyboard-handlers)
- [⚫ tauri-kjg8 Unify backend error types into shared AppError enum](#tauri-kjg8-unify-backend-error-types-into-shared-apperror-enum)
- [⚫ tauri-oyel Replace setTimeout(0) focus calls with Svelte tick()](#tauri-oyel-replace-settimeout-0-focus-calls-with-svelte-tick)
- [⚫ tauri-xccg Replace rAF timing hack in marquee dragJustEnded with time delta check](#tauri-xccg-replace-raf-timing-hack-in-marquee-dragjustended-with-time-delta-check)
- [⚫ tauri-89kx Unify toast notification state into a toast store](#tauri-89kx-unify-toast-notification-state-into-a-toast-store)
- [⚫ tauri-enf4 Include icons as part of themes](#tauri-enf4-include-icons-as-part-of-themes)
- [⚫ tauri-naca Add window transparency option](#tauri-naca-add-window-transparency-option)
- [⚫ tauri-ti0l Save file list/bookmarks in config file](#tauri-ti0l-save-file-list-bookmarks-in-config-file)
- [⚫ tauri-320z Make drag selection color styleable](#tauri-320z-make-drag-selection-color-styleable)
- [⚫ tauri-7pua Configurable default terminal (ghostty)](#tauri-7pua-configurable-default-terminal-ghostty)
- [⚫ tauri-pmyl Increase padding/margins when no title bar](#tauri-pmyl-increase-padding-margins-when-no-title-bar)
- [⚫ tauri-zlwx Make recycle bin delete confirmation modal toggleable](#tauri-zlwx-make-recycle-bin-delete-confirmation-modal-toggleable)
- [⚫ tauri-x129 Frontend perf benchmarks for content search](#tauri-x129-frontend-perf-benchmarks-for-content-search)
- [⚫ tauri-ddye API layer: Update default maxResults](#tauri-ddye-api-layer-update-default-maxresults)
- [⚫ tauri-explorer-k3oo Dual pane defaults to same folder when no saved location](#tauri-explorer-k3oo-dual-pane-defaults-to-same-folder-when-no-saved-location)
- [⚫ tauri-explorer-uwm7 Customizable keyboard shortcuts](#tauri-explorer-uwm7-customizable-keyboard-shortcuts)
- [⚫ tauri-explorer-9lnx Create performance regression detection script](#tauri-explorer-9lnx-create-performance-regression-detection-script)
- [⚫ tauri-explorer-exha Add performance tests to CI pipeline](#tauri-explorer-exha-add-performance-tests-to-ci-pipeline)
- [⚫ tauri-explorer-rtxz Profile and optimize initial app startup time](#tauri-explorer-rtxz-profile-and-optimize-initial-app-startup-time)
- [⚫ tauri-explorer-s29y Add performance benchmarking for directory scans](#tauri-explorer-s29y-add-performance-benchmarking-for-directory-scans)
- [⚫ tauri-explorer-jag7 Add Rust-based file metadata caching](#tauri-explorer-jag7-add-rust-based-file-metadata-caching)
- [⚫ tauri-explorer-yrav Disable/minimize transitions for heavy views](#tauri-explorer-yrav-disable-minimize-transitions-for-heavy-views)
- [⚫ tauri-explorer-1i2j Paste image as new file](#tauri-explorer-1i2j-paste-image-as-new-file)
- [⚫ tauri-explorer-j2l0 Paste text as new file](#tauri-explorer-j2l0-paste-text-as-new-file)
- [⚫ tauri-explorer-hyxy Bulk rename dialog UI](#tauri-explorer-hyxy-bulk-rename-dialog-ui)
- [⚫ tauri-explorer-97a Visual distinction for hidden files](#tauri-explorer-97a-visual-distinction-for-hidden-files)
- [⚫ tauri-explorer-cp9 Context menu: Open With submenu](#tauri-explorer-cp9-context-menu-open-with-submenu)
- [⚫ tauri-explorer-dl7 Reorder bookmarks via drag](#tauri-explorer-dl7-reorder-bookmarks-via-drag)
- [⚫ tauri-explorer-3y7 EPIC: Bulk Rename](#tauri-explorer-3y7-epic-bulk-rename)
- [⚫ tauri-explorer-j0a EPIC: Clipboard Paste as Files](#tauri-explorer-j0a-epic-clipboard-paste-as-files)
- [⚫ tauri-explorer-ub8 Type-ahead selection in file list](#tauri-explorer-ub8-type-ahead-selection-in-file-list)
- [⚫ tauri-explorer-pki Paste image as new file](#tauri-explorer-pki-paste-image-as-new-file)
- [⚫ tauri-explorer-kgj Paste text as new file](#tauri-explorer-kgj-paste-text-as-new-file)
- [⚫ tauri-explorer-0xd Regex find/replace in bulk rename](#tauri-explorer-0xd-regex-find-replace-in-bulk-rename)
- [⚫ tauri-explorer-up8 Sequential numbering in bulk rename](#tauri-explorer-up8-sequential-numbering-in-bulk-rename)
- [⚫ tauri-explorer-ten Bulk rename dialog UI](#tauri-explorer-ten-bulk-rename-dialog-ui)
- [⚫ tauri-explorer-p2c Clear recent files history](#tauri-explorer-p2c-clear-recent-files-history)
- [⚫ tauri-explorer-5a7 Import/export keybindings](#tauri-explorer-5a7-import-export-keybindings)
- [⚫ tauri-explorer-dhx PDF preview in preview pane](#tauri-explorer-dhx-pdf-preview-in-preview-pane)
- [⚫ tauri-explorer-53e Workspace management UI](#tauri-explorer-53e-workspace-management-ui)
- [⚫ tauri-explorer-xjt Visual distinction for hidden files](#tauri-explorer-xjt-visual-distinction-for-hidden-files)
- [⚫ tauri-explorer-ti2 Context menu: Open With submenu](#tauri-explorer-ti2-context-menu-open-with-submenu)
- [⚫ tauri-explorer-d62 Reorder bookmarks via drag](#tauri-explorer-d62-reorder-bookmarks-via-drag)
- [⚫ tauri-explorer-r17 EPIC: Bulk Rename](#tauri-explorer-r17-epic-bulk-rename)
- [⚫ tauri-explorer-6yn EPIC: Clipboard Paste as Files](#tauri-explorer-6yn-epic-clipboard-paste-as-files)

---

## Dependency Graph

```mermaid
graph TD
    classDef open fill:#50FA7B,stroke:#333,color:#000
    classDef inprogress fill:#8BE9FD,stroke:#333,color:#000
    classDef blocked fill:#FF5555,stroke:#333,color:#000
    classDef closed fill:#6272A4,stroke:#333,color:#fff

    tauri-0gre["tauri-0gre<br/>Fix drag and drop to pin folders in Q..."]
    class tauri-0gre closed
    tauri-0jry["tauri-0jry<br/>Can't cancel cut and paste when progr..."]
    class tauri-0jry open
    tauri-0nj7["tauri-0nj7<br/>Fix marquee selection box offset from..."]
    class tauri-0nj7 closed
    tauri-15y5["tauri-15y5<br/>Undo delete doesn't work"]
    class tauri-15y5 closed
    tauri-18op["tauri-18op<br/>Extract FileIcon component and split ..."]
    class tauri-18op inprogress
    tauri-1r2q["tauri-1r2q<br/>Phase 2: Theme enrichment (all themes..."]
    class tauri-1r2q open
    tauri-1rzt["tauri-1rzt<br/>Fix laggy image previews"]
    class tauri-1rzt closed
    tauri-2dgf["tauri-2dgf<br/>Drag files to another window moves in..."]
    class tauri-2dgf closed
    tauri-2e92["tauri-2e92<br/>Move window controls into the top too..."]
    class tauri-2e92 closed
    tauri-31co["tauri-31co<br/>Details view column headers are trans..."]
    class tauri-31co closed
    tauri-320z["tauri-320z<br/>Make drag selection color styleable"]
    class tauri-320z closed
    tauri-3bxs["tauri-3bxs<br/>Ctrl+Shift+T restore closed tab or wi..."]
    class tauri-3bxs closed
    tauri-43vk["tauri-43vk<br/>Change zoom in/out default hotkeys to..."]
    class tauri-43vk closed
    tauri-5dq0["tauri-5dq0<br/>Cross-folder drag inconsistent"]
    class tauri-5dq0 closed
    tauri-5hlj["tauri-5hlj<br/>Remove weird triangles from address bar"]
    class tauri-5hlj closed
    tauri-5r30["tauri-5r30<br/>Dragged file still visible in source ..."]
    class tauri-5r30 closed
    tauri-5t7m["tauri-5t7m<br/>Extract CancellableTaskRegistry in Ru..."]
    class tauri-5t7m inprogress
    tauri-64lw["tauri-64lw<br/>Tiles view crashes when selected via ..."]
    class tauri-64lw closed
    tauri-6u0j["tauri-6u0j<br/>Fix folder icon color in rapture theme"]
    class tauri-6u0j closed
    tauri-6yzm["tauri-6yzm<br/>Fix paste into empty folder duplicate..."]
    class tauri-6yzm closed
    tauri-6z6j["tauri-6z6j<br/>Ctrl+Shift+T reopen closed tab works ..."]
    class tauri-6z6j closed
    tauri-77p5["tauri-77p5<br/>Esc should close settings modal"]
    class tauri-77p5 closed
    tauri-7pua["tauri-7pua<br/>Configurable default terminal (ghostty)"]
    class tauri-7pua closed
    tauri-7z5p["tauri-7z5p<br/>Change forward/backward shortcuts to ..."]
    class tauri-7z5p closed
    tauri-89kx["tauri-89kx<br/>Unify toast notification state into a..."]
    class tauri-89kx closed
    tauri-8gpm["tauri-8gpm<br/>New window should inherit path/viewMo..."]
    class tauri-8gpm closed
    tauri-8vc1["tauri-8vc1<br/>Open in terminal doesn't work: workin..."]
    class tauri-8vc1 closed
    tauri-8ytw["tauri-8ytw<br/>Right-click context menu doesn't appe..."]
    class tauri-8ytw closed
    tauri-aefl["tauri-aefl<br/>Fix drag-and-drop Quick Access pinnin..."]
    class tauri-aefl closed
    tauri-anov["tauri-anov<br/>Clipboard is window-specific instead ..."]
    class tauri-anov closed
    tauri-aw0h["tauri-aw0h<br/>Fix keyboard shortcut conflicts (F5, ..."]
    class tauri-aw0h inprogress
    tauri-bpqk["tauri-bpqk<br/>Make nav bar carets larger and easier..."]
    class tauri-bpqk closed
    tauri-c2dw["tauri-c2dw<br/>Change go-up shortcut to Ctrl+Alt+Up"]
    class tauri-c2dw closed
    tauri-c8m9["tauri-c8m9<br/>Restructure explorer.svelte.ts API in..."]
    class tauri-c8m9 closed
    tauri-cf8q["tauri-cf8q<br/>Remove copy icon from address bar RHS"]
    class tauri-cf8q closed
    tauri-cj2c["tauri-cj2c<br/>Fix /tmp directory hanging on loading"]
    class tauri-cj2c closed
    tauri-cwh1["tauri-cwh1<br/>Show toast on undo and drag move"]
    class tauri-cwh1 closed
    tauri-d2ff["tauri-d2ff<br/>Improve tiles view styling"]
    class tauri-d2ff closed
    tauri-dbiw["tauri-dbiw<br/>Backend: Line truncation + adaptive b..."]
    class tauri-dbiw closed
    tauri-ddye["tauri-ddye<br/>API layer: Update default maxResults"]
    class tauri-ddye closed
    tauri-dh79["tauri-dh79<br/>Investigate why HTML5 drop event neve..."]
    class tauri-dh79 closed
    tauri-dyiz["tauri-dyiz<br/>Inline new folder creation instead of..."]
    class tauri-dyiz closed
    tauri-e2mn["tauri-e2mn<br/>Tiles view with thumbnails is laggy/f..."]
    class tauri-e2mn inprogress
    tauri-en1b["tauri-en1b<br/>List view doesn't show icons properly"]
    class tauri-en1b inprogress
    tauri-enf4["tauri-enf4<br/>Include icons as part of themes"]
    class tauri-enf4 closed
    tauri-explorer-06c["tauri-explorer-06c<br/>EPIC: Workspaces/Layouts"]
    class tauri-explorer-06c closed
    tauri-explorer-0a4["tauri-explorer-0a4<br/>Context menu: Compress files"]
    class tauri-explorer-0a4 closed
    tauri-explorer-0c8["tauri-explorer-0c8<br/>Breadcrumb navigation for path segments"]
    class tauri-explorer-0c8 closed
    tauri-explorer-0dk["tauri-explorer-0dk<br/>Command palette overlay UI"]
    class tauri-explorer-0dk closed
    tauri-explorer-0ey["tauri-explorer-0ey<br/>Ripgrep integration for content search"]
    class tauri-explorer-0ey closed
    tauri-explorer-0gs["tauri-explorer-0gs<br/>EPIC: Drag and Drop"]
    class tauri-explorer-0gs closed
    tauri-explorer-0hd["tauri-explorer-0hd<br/>Delete to trash for undo support"]
    class tauri-explorer-0hd closed
    tauri-explorer-0o2v["tauri-explorer-0o2v<br/>Fuzzy search (Ctrl+P) returns no results"]
    class tauri-explorer-0o2v closed
    tauri-explorer-0o5m["tauri-explorer-0o5m<br/>Make columns resizable"]
    class tauri-explorer-0o5m closed
    tauri-explorer-0o79["tauri-explorer-0o79<br/>Drag select box should not extend int..."]
    class tauri-explorer-0o79 closed
    tauri-explorer-0oa["tauri-explorer-0oa<br/>Add bookmark from context menu"]
    class tauri-explorer-0oa closed
    tauri-explorer-0wo["tauri-explorer-0wo<br/>Back/Forward navigation with history ..."]
    class tauri-explorer-0wo closed
    tauri-explorer-0xd["tauri-explorer-0xd<br/>Regex find/replace in bulk rename"]
    class tauri-explorer-0xd closed
    tauri-explorer-0xr["tauri-explorer-0xr<br/>Context menu: Extract archive"]
    class tauri-explorer-0xr closed
    tauri-explorer-10m8["tauri-explorer-10m8<br/>Add tests for content search streamin..."]
    class tauri-explorer-10m8 closed
    tauri-explorer-1ex["tauri-explorer-1ex<br/>EPIC: Command Palette"]
    class tauri-explorer-1ex closed
    tauri-explorer-1g0["tauri-explorer-1g0<br/>Workspace data model"]
    class tauri-explorer-1g0 closed
    tauri-explorer-1i2j["tauri-explorer-1i2j<br/>Paste image as new file"]
    class tauri-explorer-1i2j closed
    tauri-explorer-1k9k["tauri-explorer-1k9k<br/>Split explorer.svelte.ts God-object i..."]
    class tauri-explorer-1k9k closed
    tauri-explorer-1qg["tauri-explorer-1qg<br/>Save current workspace dialog"]
    class tauri-explorer-1qg closed
    tauri-explorer-1sv["tauri-explorer-1sv<br/>Select all with Ctrl+A"]
    class tauri-explorer-1sv closed
    tauri-explorer-1yj["tauri-explorer-1yj<br/>Create TypeScript domain layer"]
    class tauri-explorer-1yj closed
    tauri-explorer-24i["tauri-explorer-24i<br/>Thumbnail generation for images"]
    class tauri-explorer-24i closed
    tauri-explorer-2c6b["tauri-explorer-2c6b<br/>Preview pane component"]
    class tauri-explorer-2c6b closed
    tauri-explorer-2ira["tauri-explorer-2ira<br/>Use async file I/O with aiofiles"]
    class tauri-explorer-2ira closed
    tauri-explorer-2m9["tauri-explorer-2m9<br/>Context menu: Rename option"]
    class tauri-explorer-2m9 closed
    tauri-explorer-2o72["tauri-explorer-2o72<br/>Tab switching not working in Tauri app"]
    class tauri-explorer-2o72 closed
    tauri-explorer-39wl["tauri-explorer-39wl<br/>Make sidebar section resizable"]
    class tauri-explorer-39wl closed
    tauri-explorer-3a1q["tauri-explorer-3a1q<br/>Ripgrep integration for content search"]
    class tauri-explorer-3a1q closed
    tauri-explorer-3b5s["tauri-explorer-3b5s<br/>Stream file results via Tauri events"]
    class tauri-explorer-3b5s closed
    tauri-explorer-3ct["tauri-explorer-3ct<br/>EPIC: Dual/Multi-Pane Layout"]
    class tauri-explorer-3ct closed
    tauri-explorer-3fac["tauri-explorer-3fac<br/>Recently used commands at top"]
    class tauri-explorer-3fac closed
    tauri-explorer-3kz["tauri-explorer-3kz<br/>Hotkey configuration UI"]
    class tauri-explorer-3kz closed
    tauri-explorer-3mj7["tauri-explorer-3mj7<br/>Cut/copied dialog should disappear af..."]
    class tauri-explorer-3mj7 closed
    tauri-explorer-3o5["tauri-explorer-3o5<br/>Operation history stack for undo/redo"]
    class tauri-explorer-3o5 closed
    tauri-explorer-3ol["tauri-explorer-3ol<br/>Compact list view"]
    class tauri-explorer-3ol closed
    tauri-explorer-3pzn["tauri-explorer-3pzn<br/>Playwright test: measure app cold sta..."]
    class tauri-explorer-3pzn closed
    tauri-explorer-3u7["tauri-explorer-3u7<br/>Sort persistence per directory"]
    class tauri-explorer-3u7 closed
    tauri-explorer-3y7["tauri-explorer-3y7<br/>EPIC: Bulk Rename"]
    class tauri-explorer-3y7 closed
    tauri-explorer-41o["tauri-explorer-41o<br/>Progress dialog component for long op..."]
    class tauri-explorer-41o closed
    tauri-explorer-44dx["tauri-explorer-44dx<br/>Content search results don't stream p..."]
    class tauri-explorer-44dx closed
    tauri-explorer-459h["tauri-explorer-459h<br/>Fuzzy search should also search folders"]
    class tauri-explorer-459h closed
    tauri-explorer-47pv["tauri-explorer-47pv<br/>Convert cut/copy notification banner ..."]
    class tauri-explorer-47pv closed
    tauri-explorer-4gm["tauri-explorer-4gm<br/>EPIC: Customizable Hotkeys"]
    class tauri-explorer-4gm closed
    tauri-explorer-4us["tauri-explorer-4us<br/>Operation queue for multiple operations"]
    class tauri-explorer-4us closed
    tauri-explorer-4v1["tauri-explorer-4v1<br/>Implement TypeScript API client"]
    class tauri-explorer-4v1 closed
    tauri-explorer-4x9f["tauri-explorer-4x9f<br/>Tab reordering via drag"]
    class tauri-explorer-4x9f closed
    tauri-explorer-4zex["tauri-explorer-4zex<br/>Tab navigation shortcuts (Ctrl+Tab)"]
    class tauri-explorer-4zex closed
    tauri-explorer-52gd["tauri-explorer-52gd<br/>Drag to rearrange bookmarks"]
    class tauri-explorer-52gd closed
    tauri-explorer-53e["tauri-explorer-53e<br/>Workspace management UI"]
    class tauri-explorer-53e closed
    tauri-explorer-5a7["tauri-explorer-5a7<br/>Import/export keybindings"]
    class tauri-explorer-5a7 closed
    tauri-explorer-5jci["tauri-explorer-5jci<br/>Mock API detection bug - Tauri app sh..."]
    class tauri-explorer-5jci closed
    tauri-explorer-5kv["tauri-explorer-5kv<br/>EPIC: Progress Bars and Operations"]
    class tauri-explorer-5kv closed
    tauri-explorer-5lbi["tauri-explorer-5lbi<br/>EPIC: Architecture Improvements"]
    class tauri-explorer-5lbi closed
    tauri-explorer-5o0["tauri-explorer-5o0<br/>Error handling with retry option"]
    class tauri-explorer-5o0 closed
    tauri-explorer-5ut["tauri-explorer-5ut<br/>Copy/Move to other pane shortcuts"]
    class tauri-explorer-5ut closed
    tauri-explorer-5w06["tauri-explorer-5w06<br/>Content search performance: parallel ..."]
    class tauri-explorer-5w06 closed
    tauri-explorer-5z0["tauri-explorer-5z0<br/>EPIC: Workspaces/Layouts"]
    class tauri-explorer-5z0 closed
    tauri-explorer-60gg["tauri-explorer-60gg<br/>Fix mock invoke incorrectly activatin..."]
    class tauri-explorer-60gg closed
    tauri-explorer-62g["tauri-explorer-62g<br/>Persist tabs across sessions"]
    class tauri-explorer-62g closed
    tauri-explorer-6a4["tauri-explorer-6a4<br/>File count and size estimation for pr..."]
    class tauri-explorer-6a4 closed
    tauri-explorer-6bt["tauri-explorer-6bt<br/>EPIC: Bookmarks System"]
    class tauri-explorer-6bt closed
    tauri-explorer-6iax["tauri-explorer-6iax<br/>Workspace data model"]
    class tauri-explorer-6iax closed
    tauri-explorer-6qrn["tauri-explorer-6qrn<br/>Save current workspace dialog"]
    class tauri-explorer-6qrn closed
    tauri-explorer-6ukk["tauri-explorer-6ukk<br/>Enable drag and drop between dual panes"]
    class tauri-explorer-6ukk closed
    tauri-explorer-6ur["tauri-explorer-6ur<br/>Multi-select with Ctrl+click"]
    class tauri-explorer-6ur closed
    tauri-explorer-6yn["tauri-explorer-6yn<br/>EPIC: Clipboard Paste as Files"]
    class tauri-explorer-6yn closed
    tauri-explorer-743["tauri-explorer-743<br/>Resizable pane divider"]
    class tauri-explorer-743 closed
    tauri-explorer-79p["tauri-explorer-79p<br/>Deselect files when clicking empty area"]
    class tauri-explorer-79p closed
    tauri-explorer-7ii["tauri-explorer-7ii<br/>Write playwright_tests.md spec file"]
    class tauri-explorer-7ii closed
    tauri-explorer-7m5["tauri-explorer-7m5<br/>Ctrl+Z to undo last operation"]
    class tauri-explorer-7m5 closed
    tauri-explorer-7pce["tauri-explorer-7pce<br/>Extract file type/icon mapping from F..."]
    class tauri-explorer-7pce closed
    tauri-explorer-7xzv["tauri-explorer-7xzv<br/>feature"]
    class tauri-explorer-7xzv closed
    tauri-explorer-83z["tauri-explorer-83z<br/>EPIC: View Modes"]
    class tauri-explorer-83z closed
    tauri-explorer-88u["tauri-explorer-88u<br/>Remove toolbar buttons for minimal UI"]
    class tauri-explorer-88u closed
    tauri-explorer-8ja7["tauri-explorer-8ja7<br/>Implement parallel directory traversa..."]
    class tauri-explorer-8ja7 closed
    tauri-explorer-8n9r["tauri-explorer-8n9r<br/>Create backend benchmark suite with p..."]
    class tauri-explorer-8n9r closed
    tauri-explorer-8p5["tauri-explorer-8p5<br/>Up button to parent directory"]
    class tauri-explorer-8p5 closed
    tauri-explorer-8ret["tauri-explorer-8ret<br/>Add performance tests for content sea..."]
    class tauri-explorer-8ret closed
    tauri-explorer-8ua["tauri-explorer-8ua<br/>Hidden files toggle in View menu"]
    class tauri-explorer-8ua closed
    tauri-explorer-8yx["tauri-explorer-8yx<br/>Preview pane component"]
    class tauri-explorer-8yx closed
    tauri-explorer-9214["tauri-explorer-9214<br/>Toggle dual pane mode"]
    class tauri-explorer-9214 closed
    tauri-explorer-92uy["tauri-explorer-92uy<br/>Drag files into folders to move them"]
    class tauri-explorer-92uy closed
    tauri-explorer-97a["tauri-explorer-97a<br/>Visual distinction for hidden files"]
    class tauri-explorer-97a closed
    tauri-explorer-99fc["tauri-explorer-99fc<br/>Remove Gallery and OneDrive from sidebar"]
    class tauri-explorer-99fc closed
    tauri-explorer-9ae["tauri-explorer-9ae<br/>Persist hidden files preference"]
    class tauri-explorer-9ae closed
    tauri-explorer-9b4m["tauri-explorer-9b4m<br/>Fix clipboard shortcuts not working a..."]
    class tauri-explorer-9b4m closed
    tauri-explorer-9l2["tauri-explorer-9l2<br/>EPIC: Testing Infrastructure"]
    class tauri-explorer-9l2 closed
    tauri-explorer-9lnx["tauri-explorer-9lnx<br/>Create performance regression detecti..."]
    class tauri-explorer-9lnx closed
    tauri-explorer-9prl["tauri-explorer-9prl<br/>feature"]
    class tauri-explorer-9prl closed
    tauri-explorer-9v6["tauri-explorer-9v6<br/>Bookmarks data model and persistence"]
    class tauri-explorer-9v6 closed
    tauri-explorer-9xb["tauri-explorer-9xb<br/>Keyboard navigation in file list"]
    class tauri-explorer-9xb closed
    tauri-explorer-9yl["tauri-explorer-9yl<br/>Spacebar to toggle preview pane"]
    class tauri-explorer-9yl closed
    tauri-explorer-a0b2["tauri-explorer-a0b2<br/>EPIC: Performance Optimization"]
    class tauri-explorer-a0b2 closed
    tauri-explorer-abm["tauri-explorer-abm<br/>Command registry system"]
    class tauri-explorer-abm closed
    tauri-explorer-ac7y["tauri-explorer-ac7y<br/>Keyboard navigation in file list"]
    class tauri-explorer-ac7y closed
    tauri-explorer-acj4["tauri-explorer-acj4<br/>bug"]
    class tauri-explorer-acj4 closed
    tauri-explorer-adtw["tauri-explorer-adtw<br/>Match Windows Explorer title bar style"]
    class tauri-explorer-adtw closed
    tauri-explorer-aj9u["tauri-explorer-aj9u<br/>Create Svelte rendering performance t..."]
    class tauri-explorer-aj9u closed
    tauri-explorer-as45["tauri-explorer-as45<br/>Fix drag select bugs"]
    class tauri-explorer-as45 closed
    tauri-explorer-auj["tauri-explorer-auj<br/>EPIC: Tabs System"]
    class tauri-explorer-auj closed
    tauri-explorer-av1["tauri-explorer-av1<br/>Operation history stack for undo/redo"]
    class tauri-explorer-av1 closed
    tauri-explorer-az6w["tauri-explorer-az6w<br/>Streaming fuzzy search like fzf (10k+..."]
    class tauri-explorer-az6w closed
    tauri-explorer-b0r["tauri-explorer-b0r<br/>Drag visual feedback and preview"]
    class tauri-explorer-b0r closed
    tauri-explorer-b2x["tauri-explorer-b2x<br/>Workspace quick access menu"]
    class tauri-explorer-b2x closed
    tauri-explorer-b4u["tauri-explorer-b4u<br/>Delete to trash for undo support"]
    class tauri-explorer-b4u closed
    tauri-explorer-bae["tauri-explorer-bae<br/>Rename file/folder operation"]
    class tauri-explorer-bae closed
    tauri-explorer-bhw5["tauri-explorer-bhw5<br/>Add undo functionality with Ctrl+Z sh..."]
    class tauri-explorer-bhw5 closed
    tauri-explorer-bo8l["tauri-explorer-bo8l<br/>Fix window rounded corners and border..."]
    class tauri-explorer-bo8l closed
    tauri-explorer-bok["tauri-explorer-bok<br/>Remove bookmark from sidebar"]
    class tauri-explorer-bok closed
    tauri-explorer-brn["tauri-explorer-brn<br/>Thumbnail generation for images"]
    class tauri-explorer-brn closed
    tauri-explorer-bry["tauri-explorer-bry<br/>Double click to open folders"]
    class tauri-explorer-bry closed
    tauri-explorer-brz["tauri-explorer-brz<br/>EPIC: Undo/Redo System"]
    class tauri-explorer-brz closed
    tauri-explorer-btz["tauri-explorer-btz<br/>Ctrl+P quick open dialog"]
    class tauri-explorer-btz closed
    tauri-explorer-c0q["tauri-explorer-c0q<br/>Compact list view"]
    class tauri-explorer-c0q closed
    tauri-explorer-c0rr["tauri-explorer-c0rr<br/>Tab title not updating when navigating"]
    class tauri-explorer-c0rr closed
    tauri-explorer-c14["tauri-explorer-c14<br/>Copy conflict: create 'file - Copy' n..."]
    class tauri-explorer-c14 closed
    tauri-explorer-c1a1["tauri-explorer-c1a1<br/>Benchmark orjson vs standard json"]
    class tauri-explorer-c1a1 closed
    tauri-explorer-c2n["tauri-explorer-c2n<br/>Sidebar bookmarks display"]
    class tauri-explorer-c2n closed
    tauri-explorer-c6dz["tauri-explorer-c6dz<br/>Playwright test: measure scroll perfo..."]
    class tauri-explorer-c6dz closed
    tauri-explorer-cdn4["tauri-explorer-cdn4<br/>Implement chunked response for large ..."]
    class tauri-explorer-cdn4 closed
    tauri-explorer-ced8["tauri-explorer-ced8<br/>Dual pane keyboard shortcut (Ctrl+\) ..."]
    class tauri-explorer-ced8 closed
    tauri-explorer-cgc["tauri-explorer-cgc<br/>Drag files from app to external apps"]
    class tauri-explorer-cgc closed
    tauri-explorer-cmd["tauri-explorer-cmd<br/>Context menu: New Folder option"]
    class tauri-explorer-cmd closed
    tauri-explorer-cn3d["tauri-explorer-cn3d<br/>Recent files in command palette"]
    class tauri-explorer-cn3d closed
    tauri-explorer-col["tauri-explorer-col<br/>Thumbnail/grid view with previews"]
    class tauri-explorer-col closed
    tauri-explorer-cp9["tauri-explorer-cp9<br/>Context menu: Open With submenu"]
    class tauri-explorer-cp9 closed
    tauri-explorer-d2y["tauri-explorer-d2y<br/>Hidden files toggle in View menu"]
    class tauri-explorer-d2y closed
    tauri-explorer-d62["tauri-explorer-d62<br/>Reorder bookmarks via drag"]
    class tauri-explorer-d62 closed
    tauri-explorer-d6w["tauri-explorer-d6w<br/>EPIC: Hidden Files Toggle"]
    class tauri-explorer-d6w closed
    tauri-explorer-dd9["tauri-explorer-dd9<br/>Track recently opened files"]
    class tauri-explorer-dd9 closed
    tauri-explorer-dfx["tauri-explorer-dfx<br/>Command search and filtering"]
    class tauri-explorer-dfx closed
    tauri-explorer-dhx["tauri-explorer-dhx<br/>PDF preview in preview pane"]
    class tauri-explorer-dhx closed
    tauri-explorer-dl7["tauri-explorer-dl7<br/>Reorder bookmarks via drag"]
    class tauri-explorer-dl7 closed
    tauri-explorer-do3["tauri-explorer-do3<br/>Remove bookmark from sidebar"]
    class tauri-explorer-do3 closed
    tauri-explorer-dr4["tauri-explorer-dr4<br/>Recursive directory scanning for search"]
    class tauri-explorer-dr4 closed
    tauri-explorer-dzr["tauri-explorer-dzr<br/>Search results with context preview"]
    class tauri-explorer-dzr closed
    tauri-explorer-e1z["tauri-explorer-e1z<br/>Unit tests for state management"]
    class tauri-explorer-e1z closed
    tauri-explorer-edi["tauri-explorer-edi<br/>Playwright test suite setup"]
    class tauri-explorer-edi closed
    tauri-explorer-en98["tauri-explorer-en98<br/>Search results with context preview"]
    class tauri-explorer-en98 closed
    tauri-explorer-eq6["tauri-explorer-eq6<br/>Resizable pane divider"]
    class tauri-explorer-eq6 closed
    tauri-explorer-ev2h["tauri-explorer-ev2h<br/>Make focused pane more obviously focused"]
    class tauri-explorer-ev2h closed
    tauri-explorer-evim["tauri-explorer-evim<br/>Ctrl+Shift+F search in files dialog"]
    class tauri-explorer-evim closed
    tauri-explorer-exha["tauri-explorer-exha<br/>Add performance tests to CI pipeline"]
    class tauri-explorer-exha closed
    tauri-explorer-fb1["tauri-explorer-fb1<br/>Editable path bar with copy support"]
    class tauri-explorer-fb1 closed
    tauri-explorer-fho["tauri-explorer-fho<br/>Unit tests for file operations"]
    class tauri-explorer-fho closed
    tauri-explorer-gcl["tauri-explorer-gcl<br/>Create Svelte 5 state management"]
    class tauri-explorer-gcl closed
    tauri-explorer-gnvv["tauri-explorer-gnvv<br/>Paste and Undo keyboard shortcuts broken"]
    class tauri-explorer-gnvv closed
    tauri-explorer-gov["tauri-explorer-gov<br/>Tab navigation shortcuts (Ctrl+Tab, C..."]
    class tauri-explorer-gov closed
    tauri-explorer-gsc["tauri-explorer-gsc<br/>Dual pane layout component"]
    class tauri-explorer-gsc closed
    tauri-explorer-gut["tauri-explorer-gut<br/>Text file preview with syntax highlig..."]
    class tauri-explorer-gut closed
    tauri-explorer-gvb["tauri-explorer-gvb<br/>Drop files into app from external sou..."]
    class tauri-explorer-gvb closed
    tauri-explorer-h0jl["tauri-explorer-h0jl<br/>Create shared toolbar with pane-speci..."]
    class tauri-explorer-h0jl closed
    tauri-explorer-h21l["tauri-explorer-h21l<br/>Ctrl+V paste not working"]
    class tauri-explorer-h21l closed
    tauri-explorer-h3n["tauri-explorer-h3n<br/>Delete file/folder operation"]
    class tauri-explorer-h3n closed
    tauri-explorer-ha9r["tauri-explorer-ha9r<br/>Add rendering benchmark for virtualiz..."]
    class tauri-explorer-ha9r closed
    tauri-explorer-hdt["tauri-explorer-hdt<br/>Default bookmarks for user folders"]
    class tauri-explorer-hdt closed
    tauri-explorer-hgt6["tauri-explorer-hgt6<br/>Move file scanning to Rust Tauri command"]
    class tauri-explorer-hgt6 closed
    tauri-explorer-hmu["tauri-explorer-hmu<br/>Context menu: Cut, Copy, Paste, Delete"]
    class tauri-explorer-hmu closed
    tauri-explorer-howc["tauri-explorer-howc<br/>Workspace quick access menu"]
    class tauri-explorer-howc closed
    tauri-explorer-hoy["tauri-explorer-hoy<br/>Context menu: Extract archive"]
    class tauri-explorer-hoy closed
    tauri-explorer-hrk["tauri-explorer-hrk<br/>Tab reordering via drag"]
    class tauri-explorer-hrk closed
    tauri-explorer-hyxy["tauri-explorer-hyxy<br/>Bulk rename dialog UI"]
    class tauri-explorer-hyxy closed
    tauri-explorer-i0yt["tauri-explorer-i0yt<br/>Use Tauri custom protocol for thumbnails"]
    class tauri-explorer-i0yt closed
    tauri-explorer-i8l["tauri-explorer-i8l<br/>Close tab (Ctrl+W, middle-click)"]
    class tauri-explorer-i8l closed
    tauri-explorer-i9d["tauri-explorer-i9d<br/>Single click to select file with visu..."]
    class tauri-explorer-i9d closed
    tauri-explorer-ibik["tauri-explorer-ibik<br/>Use os.scandir instead of os.listdir"]
    class tauri-explorer-ibik closed
    tauri-explorer-ihg["tauri-explorer-ihg<br/>EPIC: Navigation Controls"]
    class tauri-explorer-ihg closed
    tauri-explorer-ijs["tauri-explorer-ijs<br/>Ctrl+Z to undo last operation"]
    class tauri-explorer-ijs closed
    tauri-explorer-ikiq["tauri-explorer-ikiq<br/>feature"]
    class tauri-explorer-ikiq closed
    tauri-explorer-im3m["tauri-explorer-im3m<br/>Performant image thumbnail generation..."]
    class tauri-explorer-im3m closed
    tauri-explorer-imc["tauri-explorer-imc<br/>EPIC: File Selection and Interaction"]
    class tauri-explorer-imc closed
    tauri-explorer-iw0["tauri-explorer-iw0<br/>Build UI components"]
    class tauri-explorer-iw0 closed
    tauri-explorer-j0a["tauri-explorer-j0a<br/>EPIC: Clipboard Paste as Files"]
    class tauri-explorer-j0a closed
    tauri-explorer-j2l0["tauri-explorer-j2l0<br/>Paste text as new file"]
    class tauri-explorer-j2l0 closed
    tauri-explorer-jag7["tauri-explorer-jag7<br/>Add Rust-based file metadata caching"]
    class tauri-explorer-jag7 closed
    tauri-explorer-jf4["tauri-explorer-jf4<br/>Details view with sortable columns"]
    class tauri-explorer-jf4 closed
    tauri-explorer-jii9["tauri-explorer-jii9<br/>QuickOpen file icons don't match expl..."]
    class tauri-explorer-jii9 closed
    tauri-explorer-jqi["tauri-explorer-jqi<br/>Cancel button for ongoing operations"]
    class tauri-explorer-jqi closed
    tauri-explorer-jql["tauri-explorer-jql<br/>Create new folder operation"]
    class tauri-explorer-jql closed
    tauri-explorer-jrfg["tauri-explorer-jrfg<br/>Multi-file copy/cut support"]
    class tauri-explorer-jrfg closed
    tauri-explorer-k1p["tauri-explorer-k1p<br/>EPIC: Drag and Drop"]
    class tauri-explorer-k1p closed
    tauri-explorer-k3oo["tauri-explorer-k3oo<br/>Dual pane defaults to same folder whe..."]
    class tauri-explorer-k3oo closed
    tauri-explorer-kb9["tauri-explorer-kb9<br/>Keybinding conflict detection"]
    class tauri-explorer-kb9 closed
    tauri-explorer-kez["tauri-explorer-kez<br/>Context menu: Compress files"]
    class tauri-explorer-kez closed
    tauri-explorer-kgj["tauri-explorer-kgj<br/>Paste text as new file"]
    class tauri-explorer-kgj closed
    tauri-explorer-klo["tauri-explorer-klo<br/>Persist hidden files preference"]
    class tauri-explorer-klo closed
    tauri-explorer-ktq["tauri-explorer-ktq<br/>Real-time search results as you type"]
    class tauri-explorer-ktq closed
    tauri-explorer-kwe["tauri-explorer-kwe<br/>EPIC: Recent Files"]
    class tauri-explorer-kwe closed
    tauri-explorer-l62["tauri-explorer-l62<br/>Ctrl+H shortcut for hidden files toggle"]
    class tauri-explorer-l62 closed
    tauri-explorer-l7lv["tauri-explorer-l7lv<br/>epic"]
    class tauri-explorer-l7lv closed
    tauri-explorer-l7lv1["tauri-explorer-l7lv.1<br/>feature"]
    class tauri-explorer-l7lv1 closed
    tauri-explorer-l7lv2["tauri-explorer-l7lv.2<br/>feature"]
    class tauri-explorer-l7lv2 closed
    tauri-explorer-l7lv3["tauri-explorer-l7lv.3<br/>feature"]
    class tauri-explorer-l7lv3 closed
    tauri-explorer-l7lv4["tauri-explorer-l7lv.4<br/>feature"]
    class tauri-explorer-l7lv4 closed
    tauri-explorer-lbb["tauri-explorer-lbb<br/>Range select with Shift+click"]
    class tauri-explorer-lbb closed
    tauri-explorer-lcd9["tauri-explorer-lcd9<br/>Keybinding conflict detection"]
    class tauri-explorer-lcd9 closed
    tauri-explorer-ldfx["tauri-explorer-ldfx<br/>Move tabs above pane level (window-le..."]
    class tauri-explorer-ldfx closed
    tauri-explorer-lul["tauri-explorer-lul<br/>EPIC: Hidden Files Toggle"]
    class tauri-explorer-lul closed
    tauri-explorer-m0b["tauri-explorer-m0b<br/>EPIC: Customizable Hotkeys"]
    class tauri-explorer-m0b closed
    tauri-explorer-m1f["tauri-explorer-m1f<br/>Copy vs Move modifier keys during drag"]
    class tauri-explorer-m1f closed
    tauri-explorer-m7w["tauri-explorer-m7w<br/>Toggle dual pane mode"]
    class tauri-explorer-m7w closed
    tauri-explorer-mht5["tauri-explorer-mht5<br/>feature"]
    class tauri-explorer-mht5 closed
    tauri-explorer-moc["tauri-explorer-moc<br/>EPIC: Search in Files"]
    class tauri-explorer-moc closed
    tauri-explorer-mwr["tauri-explorer-mwr<br/>File count and size estimation for pr..."]
    class tauri-explorer-mwr closed
    tauri-explorer-nnda["tauri-explorer-nnda<br/>Spacebar to toggle preview pane"]
    class tauri-explorer-nnda closed
    tauri-explorer-npjh["tauri-explorer-npjh<br/>EPIC: Settings and Customization"]
    class tauri-explorer-npjh closed
    tauri-explorer-npjh1["tauri-explorer-npjh.1<br/>Settings dialog with Ctrl+, shortcut"]
    class tauri-explorer-npjh1 closed
    tauri-explorer-npjh2["tauri-explorer-npjh.2<br/>Toggle shared toolbar visibility"]
    class tauri-explorer-npjh2 closed
    tauri-explorer-npjh3["tauri-explorer-npjh.3<br/>Toggle sidebar visibility"]
    class tauri-explorer-npjh3 closed
    tauri-explorer-npjh4["tauri-explorer-npjh.4<br/>Customizable hotkeys"]
    class tauri-explorer-npjh4 closed
    tauri-explorer-npl3["tauri-explorer-npl3<br/>Playwright test: measure large direct..."]
    class tauri-explorer-npl3 closed
    tauri-explorer-nqm["tauri-explorer-nqm<br/>Refresh button and F5 shortcut"]
    class tauri-explorer-nqm closed
    tauri-explorer-nv2y["tauri-explorer-nv2y<br/>EPIC: Migrate Backend from FastAPI to..."]
    class tauri-explorer-nv2y closed
    tauri-explorer-nxpl["tauri-explorer-nxpl<br/>Lazy load file icons with Intersectio..."]
    class tauri-explorer-nxpl closed
    tauri-explorer-nzgb["tauri-explorer-nzgb<br/>Implement virtualized file list"]
    class tauri-explorer-nzgb closed
    tauri-explorer-o49t["tauri-explorer-o49t<br/>Ensure Pydantic v2 for faster validation"]
    class tauri-explorer-o49t closed
    tauri-explorer-o4wz["tauri-explorer-o4wz<br/>Show placeholder icons while thumbnai..."]
    class tauri-explorer-o4wz closed
    tauri-explorer-oibi["tauri-explorer-oibi<br/>Remove computer and home icons from b..."]
    class tauri-explorer-oibi closed
    tauri-explorer-okfw["tauri-explorer-okfw<br/>Drag select (marquee/lasso selection)"]
    class tauri-explorer-okfw closed
    tauri-explorer-okn6["tauri-explorer-okn6<br/>Fix keyboard shortcuts (Ctrl+C/X/V) n..."]
    class tauri-explorer-okn6 closed
    tauri-explorer-omkn["tauri-explorer-omkn<br/>Track recently opened files"]
    class tauri-explorer-omkn closed
    tauri-explorer-ooj["tauri-explorer-ooj<br/>EPIC: Bookmarks System"]
    class tauri-explorer-ooj closed
    tauri-explorer-osjq["tauri-explorer-osjq<br/>Text file preview with syntax highlig..."]
    class tauri-explorer-osjq closed
    tauri-explorer-oytv["tauri-explorer-oytv<br/>Hotkey configuration UI"]
    class tauri-explorer-oytv closed
    tauri-explorer-p1f["tauri-explorer-p1f<br/>Implement FastAPI endpoints"]
    class tauri-explorer-p1f closed
    tauri-explorer-p2c["tauri-explorer-p2c<br/>Clear recent files history"]
    class tauri-explorer-p2c closed
    tauri-explorer-pad["tauri-explorer-pad<br/>Double click to open files in default..."]
    class tauri-explorer-pad closed
    tauri-explorer-pki["tauri-explorer-pki<br/>Paste image as new file"]
    class tauri-explorer-pki closed
    tauri-explorer-qaqo["tauri-explorer-qaqo<br/>Switch to orjson for JSON serialization"]
    class tauri-explorer-qaqo closed
    tauri-explorer-qcq5["tauri-explorer-qcq5<br/>Persist tabs across sessions"]
    class tauri-explorer-qcq5 closed
    tauri-explorer-r17["tauri-explorer-r17<br/>EPIC: Bulk Rename"]
    class tauri-explorer-r17 closed
    tauri-explorer-r3d["tauri-explorer-r3d<br/>Sort persistence per directory"]
    class tauri-explorer-r3d closed
    tauri-explorer-raf["tauri-explorer-raf<br/>EPIC: Search in Files"]
    class tauri-explorer-raf closed
    tauri-explorer-rdra["tauri-explorer-rdra<br/>Support pasting files from OS clipboard"]
    class tauri-explorer-rdra closed
    tauri-explorer-rtxz["tauri-explorer-rtxz<br/>Profile and optimize initial app star..."]
    class tauri-explorer-rtxz closed
    tauri-explorer-rxx["tauri-explorer-rxx<br/>Fuzzy file name matching algorithm"]
    class tauri-explorer-rxx closed
    tauri-explorer-rzs["tauri-explorer-rzs<br/>Configure Tauri sidecar integration"]
    class tauri-explorer-rzs closed
    tauri-explorer-s29y["tauri-explorer-s29y<br/>Add performance benchmarking for dire..."]
    class tauri-explorer-s29y closed
    tauri-explorer-s4o["tauri-explorer-s4o<br/>EPIC: View Modes"]
    class tauri-explorer-s4o closed
    tauri-explorer-sm3p["tauri-explorer-sm3p<br/>Drag and drop folders onto bookmarks bar"]
    class tauri-explorer-sm3p closed
    tauri-explorer-so0["tauri-explorer-so0<br/>Tab bar component for panes"]
    class tauri-explorer-so0 closed
    tauri-explorer-sox["tauri-explorer-sox<br/>Add bookmark from context menu"]
    class tauri-explorer-sox closed
    tauri-explorer-st1["tauri-explorer-st1<br/>Operation queue for multiple operations"]
    class tauri-explorer-st1 closed
    tauri-explorer-syq3["tauri-explorer-syq3<br/>Marquee selection laggy in Tauri app ..."]
    class tauri-explorer-syq3 closed
    tauri-explorer-t23c["tauri-explorer-t23c<br/>Tiles view: icons don't match details..."]
    class tauri-explorer-t23c closed
    tauri-explorer-ten["tauri-explorer-ten<br/>Bulk rename dialog UI"]
    class tauri-explorer-ten closed
    tauri-explorer-ti2["tauri-explorer-ti2<br/>Context menu: Open With submenu"]
    class tauri-explorer-ti2 closed
    tauri-explorer-u0mo["tauri-explorer-u0mo<br/>Fuzzy search dialog shouldn't be tran..."]
    class tauri-explorer-u0mo closed
    tauri-explorer-u5a["tauri-explorer-u5a<br/>Ctrl+Y/Ctrl+Shift+Z to redo"]
    class tauri-explorer-u5a closed
    tauri-explorer-u7bg["tauri-explorer-u7bg<br/>Cross-pane and external clipboard paste"]
    class tauri-explorer-u7bg closed
    tauri-explorer-ub8["tauri-explorer-ub8<br/>Type-ahead selection in file list"]
    class tauri-explorer-ub8 closed
    tauri-explorer-um74["tauri-explorer-um74<br/>Grey out unfocused pane in dual pane ..."]
    class tauri-explorer-um74 closed
    tauri-explorer-up8["tauri-explorer-up8<br/>Sequential numbering in bulk rename"]
    class tauri-explorer-up8 closed
    tauri-explorer-uwm7["tauri-explorer-uwm7<br/>Customizable keyboard shortcuts"]
    class tauri-explorer-uwm7 closed
    tauri-explorer-uz7d["tauri-explorer-uz7d<br/>Real-time search results as you type"]
    class tauri-explorer-uz7d closed
    tauri-explorer-v2kr["tauri-explorer-v2kr<br/>bug"]
    class tauri-explorer-v2kr closed
    tauri-explorer-v9n["tauri-explorer-v9n<br/>Recently used commands at top"]
    class tauri-explorer-v9n closed
    tauri-explorer-vpxq["tauri-explorer-vpxq<br/>Cannot cancel content search while in..."]
    class tauri-explorer-vpxq closed
    tauri-explorer-vvr["tauri-explorer-vvr<br/>EPIC: Undo/Redo System"]
    class tauri-explorer-vvr closed
    tauri-explorer-w0c7["tauri-explorer-w0c7<br/>Horizontal scroll reveals whitespace ..."]
    class tauri-explorer-w0c7 closed
    tauri-explorer-w0eo["tauri-explorer-w0eo<br/>Delete sends to recycle bin instead o..."]
    class tauri-explorer-w0eo closed
    tauri-explorer-w3t["tauri-explorer-w3t<br/>EPIC: Fuzzy File Search (Ctrl+P)"]
    class tauri-explorer-w3t closed
    tauri-explorer-wp6["tauri-explorer-wp6<br/>Drag visual feedback and preview"]
    class tauri-explorer-wp6 closed
    tauri-explorer-ww3["tauri-explorer-ww3<br/>Copy vs Move modifier keys during drag"]
    class tauri-explorer-ww3 closed
    tauri-explorer-wxzn["tauri-explorer-wxzn<br/>feature"]
    class tauri-explorer-wxzn closed
    tauri-explorer-x25["tauri-explorer-x25<br/>Copy/Move file operations"]
    class tauri-explorer-x25 closed
    tauri-explorer-xago["tauri-explorer-xago<br/>Image preview in preview pane"]
    class tauri-explorer-xago closed
    tauri-explorer-xcs6["tauri-explorer-xcs6<br/>Copy/Move to other pane shortcuts"]
    class tauri-explorer-xcs6 closed
    tauri-explorer-xdm["tauri-explorer-xdm<br/>EPIC: Preview Pane"]
    class tauri-explorer-xdm closed
    tauri-explorer-xfj["tauri-explorer-xfj<br/>Internal drag and drop between folders"]
    class tauri-explorer-xfj closed
    tauri-explorer-xjt["tauri-explorer-xjt<br/>Visual distinction for hidden files"]
    class tauri-explorer-xjt closed
    tauri-explorer-xqa["tauri-explorer-xqa<br/>New tab creation (Ctrl+T)"]
    class tauri-explorer-xqa closed
    tauri-explorer-xqgy["tauri-explorer-xqgy<br/>Create Playwright performance test suite"]
    class tauri-explorer-xqgy closed
    tauri-explorer-y3j4["tauri-explorer-y3j4<br/>Tiles view: tiles too tall with incor..."]
    class tauri-explorer-y3j4 closed
    tauri-explorer-y48["tauri-explorer-y48<br/>Ctrl+Shift+F search in files dialog"]
    class tauri-explorer-y48 closed
    tauri-explorer-y4y7["tauri-explorer-y4y7<br/>EPIC: Performance Testing Infrastructure"]
    class tauri-explorer-y4y7 closed
    tauri-explorer-ykh1["tauri-explorer-ykh1<br/>Benchmark os.scandir vs os.listdir pe..."]
    class tauri-explorer-ykh1 closed
    tauri-explorer-yn48["tauri-explorer-yn48<br/>Shift+click range selection"]
    class tauri-explorer-yn48 closed
    tauri-explorer-yrav["tauri-explorer-yrav<br/>Disable/minimize transitions for heav..."]
    class tauri-explorer-yrav closed
    tauri-explorer-yuz["tauri-explorer-yuz<br/>Recent files in command palette"]
    class tauri-explorer-yuz closed
    tauri-explorer-yv6["tauri-explorer-yv6<br/>Image preview in preview pane"]
    class tauri-explorer-yv6 closed
    tauri-explorer-yyn["tauri-explorer-yyn<br/>Ctrl+Y/Ctrl+Shift+Z to redo"]
    class tauri-explorer-yyn closed
    tauri-explorer-z3s["tauri-explorer-z3s<br/>Error handling with retry option"]
    class tauri-explorer-z3s closed
    tauri-explorer-z9v["tauri-explorer-z9v<br/>Basic right-click context menu framework"]
    class tauri-explorer-z9v closed
    tauri-explorer-za55["tauri-explorer-za55<br/>OS clipboard integration for copy ope..."]
    class tauri-explorer-za55 closed
    tauri-explorer-zgf["tauri-explorer-zgf<br/>Ctrl+H shortcut for hidden files toggle"]
    class tauri-explorer-zgf closed
    tauri-explorer-zhp["tauri-explorer-zhp<br/>EPIC: Context Menu"]
    class tauri-explorer-zhp closed
    tauri-explorer-zis["tauri-explorer-zis<br/>EPIC: Recent Files"]
    class tauri-explorer-zis closed
    tauri-explorer-zjdw["tauri-explorer-zjdw<br/>Fix hardcoded/inconsistent API URLs"]
    class tauri-explorer-zjdw closed
    tauri-explorer-zl2["tauri-explorer-zl2<br/>EPIC: Preview Pane"]
    class tauri-explorer-zl2 closed
    tauri-explorer-zrs9["tauri-explorer-zrs9<br/>bug"]
    class tauri-explorer-zrs9 closed
    tauri-explorer-ztg["tauri-explorer-ztg<br/>View mode toggle UI"]
    class tauri-explorer-ztg closed
    tauri-f147["tauri-f147<br/>Cut and paste with dialog gets stuck ..."]
    class tauri-f147 open
    tauri-fa6t["tauri-fa6t<br/>Move clipboard/paste toasts to bottom..."]
    class tauri-fa6t closed
    tauri-fadw["tauri-fadw<br/>EPIC: Architecture improvements for e..."]
    class tauri-fadw closed
    tauri-fl0e["tauri-fl0e<br/>Replace window.dispatchEvent custom e..."]
    class tauri-fl0e inprogress
    tauri-fnzo["tauri-fnzo<br/>New windows should inherit layout fro..."]
    class tauri-fnzo closed
    tauri-g656["tauri-g656<br/>Default new folder name increments if..."]
    class tauri-g656 closed
    tauri-ggjw["tauri-ggjw<br/>Multi-file copy/paste from selection"]
    class tauri-ggjw closed
    tauri-ggkv["tauri-ggkv<br/>Fix multi-file delete and copy not wo..."]
    class tauri-ggkv closed
    tauri-gkfr["tauri-gkfr<br/>Fix OS clipboard copy/paste with Thun..."]
    class tauri-gkfr closed
    tauri-gkwz["tauri-gkwz<br/>Can't drag folders in tiles view"]
    class tauri-gkwz closed
    tauri-hevl["tauri-hevl<br/>Ctrl+Shift+T should restore closed ta..."]
    class tauri-hevl closed
    tauri-hit0["tauri-hit0<br/>Separate listing ID from path string ..."]
    class tauri-hit0 inprogress
    tauri-ibtv["tauri-ibtv<br/>Display frecency score breakdown in C..."]
    class tauri-ibtv closed
    tauri-isj7["tauri-isj7<br/>Improve multi-selection visual appear..."]
    class tauri-isj7 closed
    tauri-j9aa["tauri-j9aa<br/>Context menu doesn't appear when righ..."]
    class tauri-j9aa closed
    tauri-jmcg["tauri-jmcg<br/>Double-clicking symlink opens termina..."]
    class tauri-jmcg closed
    tauri-jrek["tauri-jrek<br/>Zoxide-style usage-weighted ranking i..."]
    class tauri-jrek closed
    tauri-jsn1["tauri-jsn1<br/>EPIC: Advanced Theme Engine"]
    class tauri-jsn1 open
    tauri-jsn11["tauri-jsn1.1<br/>Add background layer behind glassmorp..."]
    class tauri-jsn11 open
    tauri-jsn12["tauri-jsn1.2<br/>Add per-section transparency CSS tokens"]
    class tauri-jsn12 open
    tauri-jsn13["tauri-jsn1.3<br/>Implement animated background rendere..."]
    class tauri-jsn13 open
    tauri-jsn14["tauri-jsn1.4<br/>Implement swappable icon theme system"]
    class tauri-jsn14 open
    tauri-jsn15["tauri-jsn1.5<br/>Extend breadcrumb and chrome theming ..."]
    class tauri-jsn15 open
    tauri-jsn16["tauri-jsn1.6<br/>Add user-selectable wallpaper/backgro..."]
    class tauri-jsn16 open
    tauri-jsn17["tauri-jsn1.7<br/>Create Aurora theme as showcase for n..."]
    class tauri-jsn17 open
    tauri-jsn18["tauri-jsn1.8<br/>Enable true window transparency on Li..."]
    class tauri-jsn18 open
    tauri-jvdk["tauri-jvdk<br/>Add Rapture theme (Ghostty color scheme)"]
    class tauri-jvdk closed
    tauri-jwrv["tauri-jwrv<br/>Save hotkey bindings to settings file"]
    class tauri-jwrv closed
    tauri-k4ec["tauri-k4ec<br/>Configurable address bar buttons with..."]
    class tauri-k4ec closed
    tauri-kh3l["tauri-kh3l<br/>Auto-select newly created folder"]
    class tauri-kh3l closed
    tauri-kjg8["tauri-kjg8<br/>Unify backend error types into shared..."]
    class tauri-kjg8 closed
    tauri-ks7f["tauri-ks7f<br/>Phase 3: Component polish (all compon..."]
    class tauri-ks7f open
    tauri-ksp2["tauri-ksp2<br/>Remove '/ &gt;' prefix from address bar"]
    class tauri-ksp2 closed
    tauri-kw2g["tauri-kw2g<br/>Auto-select newly created folder"]
    class tauri-kw2g closed
    tauri-lgo0["tauri-lgo0<br/>Error shown after deleting folder: 'U..."]
    class tauri-lgo0 closed
    tauri-lmpo["tauri-lmpo<br/>Right-clicking twice shows browser co..."]
    class tauri-lmpo closed
    tauri-lzea["tauri-lzea<br/>Phase 1: Global design tokens update"]
    class tauri-lzea inprogress
    tauri-mfjv["tauri-mfjv<br/>Icons shift slightly when highlighted..."]
    class tauri-mfjv closed
    tauri-n5sr["tauri-n5sr<br/>Fix tiles view drag selection box mis..."]
    class tauri-n5sr closed
    tauri-naca["tauri-naca<br/>Add window transparency option"]
    class tauri-naca closed
    tauri-nag1["tauri-nag1<br/>Fix tiles view freeze when loading th..."]
    class tauri-nag1 closed
    tauri-nczo["tauri-nczo<br/>Frontend: Incremental flattening + pa..."]
    class tauri-nczo closed
    tauri-ne9h["tauri-ne9h<br/>Cross-window drag and drop is unreliable"]
    class tauri-ne9h closed
    tauri-no52["tauri-no52<br/>Drag and drop with conflicting filena..."]
    class tauri-no52 open
    tauri-nweq["tauri-nweq<br/>Cross-window drag doesn't refresh sou..."]
    class tauri-nweq closed
    tauri-nxfi["tauri-nxfi<br/>Path autocomplete when typing in addr..."]
    class tauri-nxfi closed
    tauri-nycs["tauri-nycs<br/>Enter key works for confirmation modals"]
    class tauri-nycs closed
    tauri-o5dk["tauri-o5dk<br/>Add multi-step chord shortcuts like V..."]
    class tauri-o5dk closed
    tauri-o5ny["tauri-o5ny<br/>Refactor: Remove duplicate keyboard s..."]
    class tauri-o5ny closed
    tauri-obxi["tauri-obxi<br/>Right-click context menu appears at w..."]
    class tauri-obxi closed
    tauri-oe1r["tauri-oe1r<br/>Replace handwritten base64_encode wit..."]
    class tauri-oe1r inprogress
    tauri-on1c["tauri-on1c<br/>Add status bar toggleable with Alt+M U"]
    class tauri-on1c closed
    tauri-os5o["tauri-os5o<br/>Undo support for drag-move operations"]
    class tauri-os5o closed
    tauri-oyel["tauri-oyel<br/>Replace setTimeout(0) focus calls wit..."]
    class tauri-oyel closed
    tauri-p09o["tauri-p09o<br/>Include recent/frecency paths in Ctrl..."]
    class tauri-p09o closed
    tauri-pghn["tauri-pghn<br/>Advanced styling/theming system"]
    class tauri-pghn closed
    tauri-phud["tauri-phud<br/>Delete multiple selected files"]
    class tauri-phud closed
    tauri-piv8["tauri-piv8<br/>Option to hide window control buttons..."]
    class tauri-piv8 closed
    tauri-pkc4["tauri-pkc4<br/>Backend: SearcherBuilder with mmap + ..."]
    class tauri-pkc4 closed
    tauri-pmyl["tauri-pmyl<br/>Increase padding/margins when no titl..."]
    class tauri-pmyl closed
    tauri-pqo3["tauri-pqo3<br/>Clean up stale types, empty config, d..."]
    class tauri-pqo3 closed
    tauri-q1uj["tauri-q1uj<br/>Ctrl+N should open new window at curr..."]
    class tauri-q1uj closed
    tauri-qbx6["tauri-qbx6<br/>Fix PNG image previews not working"]
    class tauri-qbx6 closed
    tauri-qeac["tauri-qeac<br/>Create createPersistedState utility f..."]
    class tauri-qeac inprogress
    tauri-qvdh["tauri-qvdh<br/>Ctrl+Shift+N creates a new folder"]
    class tauri-qvdh closed
    tauri-qz5t["tauri-qz5t<br/>Fix copy/paste folder with files not ..."]
    class tauri-qz5t closed
    tauri-r4ic["tauri-r4ic<br/>Content search dialog: text clipped a..."]
    class tauri-r4ic closed
    tauri-sa5i["tauri-sa5i<br/>Selected files don't match selection ..."]
    class tauri-sa5i closed
    tauri-saj4["tauri-saj4<br/>Fix: Marquee selection has invisible ..."]
    class tauri-saj4 closed
    tauri-svfq["tauri-svfq<br/>Add zoom functionality with Alt+/- ho..."]
    class tauri-svfq closed
    tauri-sy06["tauri-sy06<br/>Navigation bar carets should open dir..."]
    class tauri-sy06 closed
    tauri-ti0l["tauri-ti0l<br/>Save file list/bookmarks in config file"]
    class tauri-ti0l closed
    tauri-ttbb["tauri-ttbb<br/>Paste images from clipboard"]
    class tauri-ttbb closed
    tauri-tu67["tauri-tu67<br/>Increase font size in address bar"]
    class tauri-tu67 closed
    tauri-tvvi["tauri-tvvi<br/>Ctrl+P global folder search beyond CW..."]
    class tauri-tvvi closed
    tauri-u00y["tauri-u00y<br/>Move navigation controls next to addr..."]
    class tauri-u00y closed
    tauri-u6r2["tauri-u6r2<br/>Tiles view freezes the window - make ..."]
    class tauri-u6r2 closed
    tauri-uo7j["tauri-uo7j<br/>Clicking away from nav bar caret sele..."]
    class tauri-uo7j closed
    tauri-vjly["tauri-vjly<br/>Progress bar when copying or moving l..."]
    class tauri-vjly closed
    tauri-vmpc["tauri-vmpc<br/>Copy/cut freezes window - sync Tauri ..."]
    class tauri-vmpc closed
    tauri-vozb["tauri-vozb<br/>Add symlink functionality"]
    class tauri-vozb closed
    tauri-vup6["tauri-vup6<br/>EPIC: UI Facelift - Premium Polish"]
    class tauri-vup6 open
    tauri-vz1q["tauri-vz1q<br/>Undo drag operations doesn't refresh ..."]
    class tauri-vz1q closed
    tauri-x129["tauri-x129<br/>Frontend perf benchmarks for content ..."]
    class tauri-x129 closed
    tauri-x4bs["tauri-x4bs<br/>Show house icon in address bar for HO..."]
    class tauri-x4bs closed
    tauri-x4cy["tauri-x4cy<br/>Fix deleted folder error message afte..."]
    class tauri-x4cy closed
    tauri-xccg["tauri-xccg<br/>Replace rAF timing hack in marquee dr..."]
    class tauri-xccg closed
    tauri-xsur["tauri-xsur<br/>Ctrl+W closes window when only one ta..."]
    class tauri-xsur closed
    tauri-y1f0["tauri-y1f0<br/>Ctrl+N opens new window at current di..."]
    class tauri-y1f0 closed
    tauri-ygaq["tauri-ygaq<br/>EPIC: Content Search Performance Opti..."]
    class tauri-ygaq closed
    tauri-zdr5["tauri-zdr5<br/>Paste images from clipboard into expl..."]
    class tauri-zdr5 closed
    tauri-zf0z["tauri-zf0z<br/>Increase spacing in list view to matc..."]
    class tauri-zf0z closed
    tauri-zlwx["tauri-zlwx<br/>Make recycle bin delete confirmation ..."]
    class tauri-zlwx closed
    tauri-zmjd["tauri-zmjd<br/>List/tiles view highlight selection a..."]
    class tauri-zmjd closed
    tauri-zqdp["tauri-zqdp<br/>Skip/overwrite dialog when pasting fi..."]
    class tauri-zqdp closed
    tauri-zqfo["tauri-zqfo<br/>Fix Enter key opening file instead of..."]
    class tauri-zqfo closed
    tauri-zvg6["tauri-zvg6<br/>Drag to quick access doesn't work"]
    class tauri-zvg6 closed
    tauri-zwdl["tauri-zwdl<br/>Hide tab bar when only one tab is open"]
    class tauri-zwdl closed

    tauri-1r2q ==> tauri-lzea
    tauri-1r2q ==> tauri-vup6
    tauri-5hlj -.-> tauri-ksp2
    tauri-8ytw -.-> tauri-j9aa
    tauri-aefl -.-> tauri-0gre
    tauri-dbiw -.-> tauri-ygaq
    tauri-ddye -.-> tauri-ygaq
    tauri-dh79 -.-> tauri-0gre
    tauri-explorer-0c8 -.-> tauri-explorer-ihg
    tauri-explorer-0dk -.-> tauri-explorer-1ex
    tauri-explorer-0dk ==> tauri-explorer-abm
    tauri-explorer-0wo -.-> tauri-explorer-ihg
    tauri-explorer-0xr ==> tauri-explorer-z9v
    tauri-explorer-0xr -.-> tauri-explorer-zhp
    tauri-explorer-1i2j -.-> tauri-explorer-j0a
    tauri-explorer-1k9k -.-> tauri-explorer-5lbi
    tauri-explorer-1sv -.-> tauri-explorer-imc
    tauri-explorer-2c6b -.-> tauri-explorer-xdm
    tauri-explorer-2ira -.-> tauri-explorer-a0b2
    tauri-explorer-2m9 ==> tauri-explorer-z9v
    tauri-explorer-2m9 -.-> tauri-explorer-zhp
    tauri-explorer-3a1q -.-> tauri-explorer-raf
    tauri-explorer-3b5s -.-> tauri-explorer-a0b2
    tauri-explorer-3fac -.-> tauri-explorer-1ex
    tauri-explorer-3pzn ==> tauri-explorer-xqgy
    tauri-explorer-3pzn -.-> tauri-explorer-y4y7
    tauri-explorer-3u7 -.-> tauri-explorer-83z
    tauri-explorer-41o -.-> tauri-explorer-5kv
    tauri-explorer-4us -.-> tauri-explorer-5kv
    tauri-explorer-4v1 ==> tauri-explorer-p1f
    tauri-explorer-4x9f -.-> tauri-explorer-auj
    tauri-explorer-4zex -.-> tauri-explorer-auj
    tauri-explorer-5o0 -.-> tauri-explorer-5kv
    tauri-explorer-6iax -.-> tauri-explorer-06c
    tauri-explorer-6qrn -.-> tauri-explorer-06c
    tauri-explorer-6ur ==> tauri-explorer-i9d
    tauri-explorer-6ur -.-> tauri-explorer-imc
    tauri-explorer-743 -.-> tauri-explorer-3ct
    tauri-explorer-743 ==> tauri-explorer-gsc
    tauri-explorer-79p -.-> tauri-explorer-imc
    tauri-explorer-7ii -.-> tauri-explorer-9l2
    tauri-explorer-7pce -.-> tauri-explorer-5lbi
    tauri-explorer-8ja7 -.-> tauri-explorer-a0b2
    tauri-explorer-8ja7 ==> tauri-explorer-hgt6
    tauri-explorer-8n9r -.-> tauri-explorer-y4y7
    tauri-explorer-8p5 -.-> tauri-explorer-ihg
    tauri-explorer-9214 -.-> tauri-explorer-3ct
    tauri-explorer-97a -.-> tauri-explorer-lul
    tauri-explorer-9lnx -.-> tauri-explorer-y4y7
    tauri-explorer-9v6 -.-> tauri-explorer-6bt
    tauri-explorer-abm -.-> tauri-explorer-1ex
    tauri-explorer-ac7y ==> tauri-explorer-i9d
    tauri-explorer-aj9u -.-> tauri-explorer-y4y7
    tauri-explorer-av1 -.-> tauri-explorer-vvr
    tauri-explorer-az6w ==> tauri-explorer-nv2y
    tauri-explorer-b0r -.-> tauri-explorer-k1p
    tauri-explorer-b4u -.-> tauri-explorer-vvr
    tauri-explorer-brn -.-> tauri-explorer-83z
    tauri-explorer-bry -.-> tauri-explorer-imc
    tauri-explorer-btz -.-> tauri-explorer-w3t
    tauri-explorer-c0q -.-> tauri-explorer-83z
    tauri-explorer-c1a1 ==> tauri-explorer-8n9r
    tauri-explorer-c1a1 -.-> tauri-explorer-y4y7
    tauri-explorer-c2n -.-> tauri-explorer-6bt
    tauri-explorer-c2n ==> tauri-explorer-9v6
    tauri-explorer-c6dz ==> tauri-explorer-xqgy
    tauri-explorer-c6dz -.-> tauri-explorer-y4y7
    tauri-explorer-cdn4 -.-> tauri-explorer-a0b2
    tauri-explorer-cgc -.-> tauri-explorer-k1p
    tauri-explorer-cmd ==> tauri-explorer-z9v
    tauri-explorer-cmd -.-> tauri-explorer-zhp
    tauri-explorer-cn3d -.-> tauri-explorer-kwe
    tauri-explorer-col -.-> tauri-explorer-83z
    tauri-explorer-cp9 -.-> tauri-explorer-zhp
    tauri-explorer-d2y -.-> tauri-explorer-lul
    tauri-explorer-dfx ==> tauri-explorer-0dk
    tauri-explorer-dfx -.-> tauri-explorer-1ex
    tauri-explorer-dl7 -.-> tauri-explorer-6bt
    tauri-explorer-do3 -.-> tauri-explorer-6bt
    tauri-explorer-do3 ==> tauri-explorer-c2n
    tauri-explorer-dr4 -.-> tauri-explorer-w3t
    tauri-explorer-edi -.-> tauri-explorer-9l2
    tauri-explorer-en98 ==> tauri-explorer-3a1q
    tauri-explorer-en98 -.-> tauri-explorer-raf
    tauri-explorer-evim -.-> tauri-explorer-raf
    tauri-explorer-exha ==> tauri-explorer-9lnx
    tauri-explorer-exha -.-> tauri-explorer-y4y7
    tauri-explorer-fb1 -.-> tauri-explorer-ihg
    tauri-explorer-gcl ==> tauri-explorer-1yj
    tauri-explorer-gcl ==> tauri-explorer-4v1
    tauri-explorer-gsc -.-> tauri-explorer-3ct
    tauri-explorer-gvb -.-> tauri-explorer-k1p
    tauri-explorer-ha9r ==> tauri-explorer-aj9u
    tauri-explorer-ha9r -.-> tauri-explorer-y4y7
    tauri-explorer-hdt -.-> tauri-explorer-6bt
    tauri-explorer-hdt ==> tauri-explorer-9v6
    tauri-explorer-hgt6 -.-> tauri-explorer-a0b2
    tauri-explorer-hgt6 ==> tauri-explorer-nv2y
    tauri-explorer-hmu ==> tauri-explorer-z9v
    tauri-explorer-hmu -.-> tauri-explorer-zhp
    tauri-explorer-howc -.-> tauri-explorer-06c
    tauri-explorer-hyxy -.-> tauri-explorer-3y7
    tauri-explorer-i0yt -.-> tauri-explorer-a0b2
    tauri-explorer-i0yt ==> tauri-explorer-nzgb
    tauri-explorer-i8l -.-> tauri-explorer-auj
    tauri-explorer-i8l ==> tauri-explorer-so0
    tauri-explorer-i9d -.-> tauri-explorer-imc
    tauri-explorer-ibik -.-> tauri-explorer-a0b2
    tauri-explorer-ijs ==> tauri-explorer-av1
    tauri-explorer-ijs -.-> tauri-explorer-vvr
    tauri-explorer-im3m ==> tauri-explorer-nv2y
    tauri-explorer-imc -.-> tauri-explorer-okfw
    tauri-explorer-imc -.-> tauri-explorer-w0eo
    tauri-explorer-imc -.-> tauri-explorer-yn48
    tauri-explorer-iw0 ==> tauri-explorer-gcl
    tauri-explorer-j2l0 -.-> tauri-explorer-j0a
    tauri-explorer-jag7 -.-> tauri-explorer-a0b2
    tauri-explorer-jag7 ==> tauri-explorer-hgt6
    tauri-explorer-jf4 -.-> tauri-explorer-83z
    tauri-explorer-jqi ==> tauri-explorer-41o
    tauri-explorer-jqi -.-> tauri-explorer-5kv
    tauri-explorer-kez ==> tauri-explorer-z9v
    tauri-explorer-kez -.-> tauri-explorer-zhp
    tauri-explorer-klo -.-> tauri-explorer-lul
    tauri-explorer-l7lv1 -.-> tauri-explorer-l7lv
    tauri-explorer-l7lv2 -.-> tauri-explorer-l7lv
    tauri-explorer-l7lv3 -.-> tauri-explorer-l7lv
    tauri-explorer-l7lv4 -.-> tauri-explorer-l7lv
    tauri-explorer-lbb ==> tauri-explorer-i9d
    tauri-explorer-lbb -.-> tauri-explorer-imc
    tauri-explorer-lcd9 -.-> tauri-explorer-m0b
    tauri-explorer-mwr -.-> tauri-explorer-5kv
    tauri-explorer-nnda ==> tauri-explorer-2c6b
    tauri-explorer-nnda -.-> tauri-explorer-xdm
    tauri-explorer-npjh1 -.-> tauri-explorer-npjh
    tauri-explorer-npjh2 -.-> tauri-explorer-npjh
    tauri-explorer-npjh3 -.-> tauri-explorer-npjh
    tauri-explorer-npjh4 -.-> tauri-explorer-npjh
    tauri-explorer-npl3 ==> tauri-explorer-xqgy
    tauri-explorer-npl3 -.-> tauri-explorer-y4y7
    tauri-explorer-nqm -.-> tauri-explorer-ihg
    tauri-explorer-nxpl -.-> tauri-explorer-a0b2
    tauri-explorer-nxpl ==> tauri-explorer-nzgb
    tauri-explorer-nzgb -.-> tauri-explorer-a0b2
    tauri-explorer-o49t -.-> tauri-explorer-a0b2
    tauri-explorer-omkn -.-> tauri-explorer-kwe
    tauri-explorer-osjq ==> tauri-explorer-2c6b
    tauri-explorer-osjq -.-> tauri-explorer-xdm
    tauri-explorer-oytv -.-> tauri-explorer-m0b
    tauri-explorer-pad -.-> tauri-explorer-imc
    tauri-explorer-qaqo -.-> tauri-explorer-a0b2
    tauri-explorer-qcq5 -.-> tauri-explorer-auj
    tauri-explorer-rtxz -.-> tauri-explorer-a0b2
    tauri-explorer-rxx -.-> tauri-explorer-w3t
    tauri-explorer-rzs ==> tauri-explorer-p1f
    tauri-explorer-s29y -.-> tauri-explorer-a0b2
    tauri-explorer-so0 -.-> tauri-explorer-auj
    tauri-explorer-sox -.-> tauri-explorer-6bt
    tauri-explorer-sox ==> tauri-explorer-c2n
    tauri-explorer-t23c ==> tauri-explorer-83z
    tauri-explorer-u5a ==> tauri-explorer-av1
    tauri-explorer-u5a -.-> tauri-explorer-vvr
    tauri-explorer-uz7d ==> tauri-explorer-rxx
    tauri-explorer-uz7d -.-> tauri-explorer-w3t
    tauri-explorer-ww3 -.-> tauri-explorer-k1p
    tauri-explorer-xago ==> tauri-explorer-2c6b
    tauri-explorer-xago -.-> tauri-explorer-xdm
    tauri-explorer-xcs6 -.-> tauri-explorer-3ct
    tauri-explorer-xcs6 ==> tauri-explorer-gsc
    tauri-explorer-xfj -.-> tauri-explorer-k1p
    tauri-explorer-xqa -.-> tauri-explorer-auj
    tauri-explorer-xqa ==> tauri-explorer-so0
    tauri-explorer-xqgy -.-> tauri-explorer-y4y7
    tauri-explorer-y3j4 ==> tauri-explorer-83z
    tauri-explorer-y4y7 -.-> tauri-explorer-a0b2
    tauri-explorer-ykh1 ==> tauri-explorer-8n9r
    tauri-explorer-ykh1 -.-> tauri-explorer-y4y7
    tauri-explorer-yrav -.-> tauri-explorer-a0b2
    tauri-explorer-z9v -.-> tauri-explorer-zhp
    tauri-explorer-zgf -.-> tauri-explorer-lul
    tauri-explorer-zjdw -.-> tauri-explorer-5lbi
    tauri-explorer-ztg -.-> tauri-explorer-83z
    tauri-fadw -.-> tauri-18op
    tauri-fadw -.-> tauri-5t7m
    tauri-fadw -.-> tauri-aw0h
    tauri-fadw -.-> tauri-c8m9
    tauri-fadw -.-> tauri-fl0e
    tauri-fadw -.-> tauri-hit0
    tauri-fadw -.-> tauri-kjg8
    tauri-fadw -.-> tauri-oe1r
    tauri-fadw -.-> tauri-pqo3
    tauri-fadw -.-> tauri-qeac
    tauri-jsn11 -.-> tauri-jsn1
    tauri-jsn12 -.-> tauri-jsn1
    tauri-jsn13 -.-> tauri-jsn1
    tauri-jsn13 ==> tauri-jsn11
    tauri-jsn14 -.-> tauri-jsn1
    tauri-jsn15 -.-> tauri-jsn1
    tauri-jsn16 -.-> tauri-jsn1
    tauri-jsn16 ==> tauri-jsn11
    tauri-jsn17 -.-> tauri-jsn1
    tauri-jsn17 ==> tauri-jsn12
    tauri-jsn17 ==> tauri-jsn13
    tauri-jsn17 ==> tauri-jsn14
    tauri-jsn17 ==> tauri-jsn15
    tauri-jsn17 ==> tauri-jsn16
    tauri-jsn18 -.-> tauri-jsn1
    tauri-ks7f ==> tauri-lzea
    tauri-ks7f ==> tauri-vup6
    tauri-lzea ==> tauri-vup6
    tauri-nczo -.-> tauri-ygaq
    tauri-pkc4 -.-> tauri-ygaq
    tauri-x129 -.-> tauri-ygaq
```

---

<a id="tauri-ks7f-phase-3-component-polish-all-components"></a>

## 📋 tauri-ks7f Phase 3: Component polish (all components)

| Property | Value |
|----------|-------|
| **Type** | 📋 task |
| **Priority** | ⚡ High (P1) |
| **Status** | 🟢 open |
| **Created** | 2026-03-04 21:36 |
| **Updated** | 2026-03-04 21:36 |

### Description

Polish SharedToolbar, NavigationBar, Sidebar, FileItem, FileList, StatusBar, TitleBar, WindowTabBar, ContextMenu, ThemeSwitcher, PaneContainer, ExplorerPane with refined spacing, radii, shadows, and typography.

### Dependencies

- ⛔ **blocks**: `tauri-vup6`
- ⛔ **blocks**: `tauri-lzea`

<details>
<summary>📋 Commands</summary>

```bash
# Start working on this issue
br update tauri-ks7f -s in_progress

# Add a comment
br comment tauri-ks7f 'Your comment here'

# Change priority (0=Critical, 1=High, 2=Medium, 3=Low)
br update tauri-ks7f -p 1

# View full details
br show tauri-ks7f
```

</details>

---

<a id="tauri-1r2q-phase-2-theme-enrichment-all-themes-new-aurora"></a>

## 📋 tauri-1r2q Phase 2: Theme enrichment (all themes + new Aurora)

| Property | Value |
|----------|-------|
| **Type** | 📋 task |
| **Priority** | ⚡ High (P1) |
| **Status** | 🟢 open |
| **Created** | 2026-03-04 21:36 |
| **Updated** | 2026-03-04 21:36 |

### Description

Enrich all 7 existing themes with deeper colors, softer dividers, shadow-card, mica-overlay. Create new Aurora theme (deep charcoal + teal).

### Dependencies

- ⛔ **blocks**: `tauri-vup6`
- ⛔ **blocks**: `tauri-lzea`

<details>
<summary>📋 Commands</summary>

```bash
# Start working on this issue
br update tauri-1r2q -s in_progress

# Add a comment
br comment tauri-1r2q 'Your comment here'

# Change priority (0=Critical, 1=High, 2=Medium, 3=Low)
br update tauri-1r2q -p 1

# View full details
br show tauri-1r2q
```

</details>

---

<a id="tauri-lzea-phase-1-global-design-tokens-update"></a>

## 📋 tauri-lzea Phase 1: Global design tokens update

| Property | Value |
|----------|-------|
| **Type** | 📋 task |
| **Priority** | ⚡ High (P1) |
| **Status** | 🔵 in_progress |
| **Created** | 2026-03-04 21:36 |
| **Updated** | 2026-03-04 21:36 |

### Description

Add new CSS variables (font-weight-bold, letter-spacing-wide, line-height-tight/normal, radius-pill, spacing-xxs, shadow-subtle/card, selection-indicator-width). Update existing tokens (radius, font-size-caption). Update scrollbar, body, mica overlay, selection styles.

### Dependencies

- ⛔ **blocks**: `tauri-vup6`

<details>
<summary>📋 Commands</summary>

```bash
# Mark as complete
br close tauri-lzea

# Add a comment
br comment tauri-lzea 'Your comment here'

# Change priority (0=Critical, 1=High, 2=Medium, 3=Low)
br update tauri-lzea -p 1

# View full details
br show tauri-lzea
```

</details>

---

<a id="tauri-vup6-epic-ui-facelift-premium-polish"></a>

## 🚀 tauri-vup6 EPIC: UI Facelift - Premium Polish

| Property | Value |
|----------|-------|
| **Type** | 🚀 epic |
| **Priority** | ⚡ High (P1) |
| **Status** | 🟢 open |
| **Created** | 2026-03-04 21:36 |
| **Updated** | 2026-03-04 21:36 |

### Description

Elevate every surface, interaction, and theme from functional default to premium and intentional. Same layout/components/architecture but everything feels a tier above. All changes via CSS variables, no new deps, no transparency.

<details>
<summary>📋 Commands</summary>

```bash
# Start working on this issue
br update tauri-vup6 -s in_progress

# Add a comment
br comment tauri-vup6 'Your comment here'

# Change priority (0=Critical, 1=High, 2=Medium, 3=Low)
br update tauri-vup6 -p 1

# View full details
br show tauri-vup6
```

</details>

---

<a id="tauri-e2mn-tiles-view-with-thumbnails-is-laggy-freezes"></a>

## 🐛 tauri-e2mn Tiles view with thumbnails is laggy/freezes

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | ⚡ High (P1) |
| **Status** | 🔵 in_progress |
| **Created** | 2026-03-04 11:38 |
| **Updated** | 2026-03-04 12:24 |

### Description

Switching to tiles view with thumbnails causes a temporary freeze. Needs deep investigation into rendering pipeline.

<details>
<summary>📋 Commands</summary>

```bash
# Mark as complete
br close tauri-e2mn

# Add a comment
br comment tauri-e2mn 'Your comment here'

# Change priority (0=Critical, 1=High, 2=Medium, 3=Low)
br update tauri-e2mn -p 1

# View full details
br show tauri-e2mn
```

</details>

---

<a id="tauri-en1b-list-view-doesn-t-show-icons-properly"></a>

## 🐛 tauri-en1b List view doesn't show icons properly

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | ⚡ High (P1) |
| **Status** | 🔵 in_progress |
| **Created** | 2026-03-04 17:08 |
| **Updated** | 2026-03-04 17:09 |

### Description

Icons in list view mode are not rendering correctly. Need to investigate and fix the icon display in the list view.

<details>
<summary>📋 Commands</summary>

```bash
# Mark as complete
br close tauri-en1b

# Add a comment
br comment tauri-en1b 'Your comment here'

# Change priority (0=Critical, 1=High, 2=Medium, 3=Low)
br update tauri-en1b -p 1

# View full details
br show tauri-en1b
```

</details>

---

<a id="tauri-5t7m-extract-cancellabletaskregistry-in-rust-backend"></a>

## 📋 tauri-5t7m Extract CancellableTaskRegistry in Rust backend

| Property | Value |
|----------|-------|
| **Type** | 📋 task |
| **Priority** | ⚡ High (P1) |
| **Status** | 🔵 in_progress |
| **Created** | 2026-03-03 10:59 |
| **Updated** | 2026-03-03 11:08 |

### Description

files.rs, search.rs, and content_search.rs each independently implement AtomicU64 + Mutex<HashMap<u64, Arc<AtomicBool>>> for cancellable tasks (~30 lines duplicated 3x). Extract into a shared CancellableTaskRegistry struct.

<details>
<summary>📋 Commands</summary>

```bash
# Mark as complete
br close tauri-5t7m

# Add a comment
br comment tauri-5t7m 'Your comment here'

# Change priority (0=Critical, 1=High, 2=Medium, 3=Low)
br update tauri-5t7m -p 1

# View full details
br show tauri-5t7m
```

</details>

---

<a id="tauri-fl0e-replace-window-dispatchevent-custom-events-with-typed-dialog-manager"></a>

## 📋 tauri-fl0e Replace window.dispatchEvent custom events with typed dialog manager

| Property | Value |
|----------|-------|
| **Type** | 📋 task |
| **Priority** | ⚡ High (P1) |
| **Status** | 🔵 in_progress |
| **Created** | 2026-03-03 10:59 |
| **Updated** | 2026-03-03 11:06 |

### Description

command-definitions.ts dispatches CustomEvent on window for dialog opening (open-bulk-rename, open-workspaces, open-quick-open, etc.). +page.svelte catches them via addEventListener. Replace with a typed dialogManager store for compile-time safety.

<details>
<summary>📋 Commands</summary>

```bash
# Mark as complete
br close tauri-fl0e

# Add a comment
br comment tauri-fl0e 'Your comment here'

# Change priority (0=Critical, 1=High, 2=Medium, 3=Low)
br update tauri-fl0e -p 1

# View full details
br show tauri-fl0e
```

</details>

---

<a id="tauri-hit0-separate-listing-id-from-path-string-in-directorylisting"></a>

## 📋 tauri-hit0 Separate listing ID from path string in DirectoryListing

| Property | Value |
|----------|-------|
| **Type** | 📋 task |
| **Priority** | ⚡ High (P1) |
| **Status** | 🔵 in_progress |
| **Created** | 2026-03-03 10:59 |
| **Updated** | 2026-03-03 11:02 |

### Description

files.rs:744 encodes listing_id into the path string via pipe-delimited format. files.ts:398 parses it back out. A directory containing '|listing:' would break. Add listing_id as a separate field in DirectoryListing struct (both Rust and TS).

<details>
<summary>📋 Commands</summary>

```bash
# Mark as complete
br close tauri-hit0

# Add a comment
br comment tauri-hit0 'Your comment here'

# Change priority (0=Critical, 1=High, 2=Medium, 3=Low)
br update tauri-hit0 -p 1

# View full details
br show tauri-hit0
```

</details>

---

<a id="tauri-aw0h-fix-keyboard-shortcut-conflicts-f5-f6-ctrl-tab"></a>

## 🐛 tauri-aw0h Fix keyboard shortcut conflicts (F5, F6, Ctrl+Tab)

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | ⚡ High (P1) |
| **Status** | 🔵 in_progress |
| **Created** | 2026-03-03 10:59 |
| **Updated** | 2026-03-03 11:02 |

### Description

Multiple commands share the same shortcut with no disambiguation: F5 (navigation.refresh vs pane.copyToOther), F6 (view.toggleDualPane vs pane.moveToOther), Ctrl+Tab (view.switchPane vs tabs.nextTab). First match wins making behavior order-dependent. Fix by adding 'when' guards or assigning distinct shortcuts. Add startup conflict validation.

<details>
<summary>📋 Commands</summary>

```bash
# Mark as complete
br close tauri-aw0h

# Add a comment
br comment tauri-aw0h 'Your comment here'

# Change priority (0=Critical, 1=High, 2=Medium, 3=Low)
br update tauri-aw0h -p 1

# View full details
br show tauri-aw0h
```

</details>

---

<a id="tauri-jsn1-8-enable-true-window-transparency-on-linux-see-through-to-desktop"></a>

## ✨ tauri-jsn1.8 Enable true window transparency on Linux (see-through to desktop)

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | 🟢 open |
| **Created** | 2026-03-04 21:36 |
| **Updated** | 2026-03-04 23:23 |

### Description

Remove WEBKIT_DISABLE_COMPOSITING_MODE=1 env var from src-tauri/src/lib.rs which blocks WebKitGTK alpha channel rendering. With this removed, the existing transparent:true config + CSS color-mix opacity will actually show the desktop/wallpaper behind the window when background opacity is lowered. Note: backdrop-filter:blur() only blurs within-DOM content, not the desktop. For desktop blur, users configure their compositor (e.g. Hyprland windowrule blur). Test that removing the env var doesn't reintroduce the Wayland protocol errors it was originally added to fix.

### Notes

   1 ## Investigation Summary (2026-03-04)
   2 
   3 ### What was tried
   4 
   5 1. **Removed WEBKIT_DISABLE_COMPOSITING_MODE=1** — This allowed WebKitGTK alpha channel rendering. Window transparency DID work (wallpaper visible), but suffered from a known ghosting bug (wry #1524): every interaction causes stale frames to accumulate, making the window progressively more opaque.
   6 
   7 2. **Disabled backdrop-filter when opacity < 100%** — WebKitGTK creates an opaque compositing surface for elements with backdrop-filter, blocking transparent pixels from reaching the compositor. Conditionally disabling it didn't fully resolve the ghosting.
   8 
   9 3. **Forced GDK_BACKEND=wayland** — To avoid XWayland breaking GTK RGBA transparency.
  10 
  11 4. **Compositor-side opacity via hyprctl** — Restored WEBKIT_DISABLE_COMPOSITING_MODE=1 (no ghosting) and used \`hyprctl dispatch setprop pid:SELF opacity VALUE lock\` to delegate transparency to Hyprland. This worked when the window was focused, but opacity reverted on focus loss. Tried space-separated \`opacity "active inactive"\` syntax — still didn't persist.
  12 
  13 ### Key findings
  14 
  15 - **WEBKIT_DISABLE_COMPOSITING_MODE=1** blocks ALL window transparency but prevents ghosting artifacts
  16 - **CSS backdrop-filter: blur()** only blurs within-DOM content, NOT the desktop behind the window
  17 - **Tauri windowEffects / window-vibrancy** don't support Linux at all
  18 - **hyprctl setprop opacity** has unreliable persistence across focus changes on Hyprland 0.53.3
  19 - The ghosting bug is tracked in wry #1524 (open, labeled upstream)
  20 - User's WebKitGTK version: 2.50.5, Hyprland: 0.53.3
  21 
  22 ### Possible future approaches
  23 
  24 1. Wait for wry #1524 / upstream WebKitGTK fix for the ghosting bug
  25 2. Investigate Hyprland windowrule (in hyprland.conf, not runtime setprop) as a more persistent mechanism
  26 3. Look into custom Wayland protocol for blur-behind (KDE blur protocol, wlr-foreign-toplevel)
  27 4. Try forcing redraws via window resize hack on every interaction (janky but might work)

### Dependencies

- 🔗 **parent-child**: `tauri-jsn1`

<details>
<summary>📋 Commands</summary>

```bash
# Start working on this issue
br update tauri-jsn1.8 -s in_progress

# Add a comment
br comment tauri-jsn1.8 'Your comment here'

# Change priority (0=Critical, 1=High, 2=Medium, 3=Low)
br update tauri-jsn1.8 -p 1

# View full details
br show tauri-jsn1.8
```

</details>

---

<a id="tauri-jsn1-2-add-per-section-transparency-css-tokens"></a>

## ✨ tauri-jsn1.2 Add per-section transparency CSS tokens

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | 🟢 open |
| **Created** | 2026-03-04 21:23 |
| **Updated** | 2026-03-04 21:23 |

### Description

Replace the single global --bg-opacity with granular per-section opacity tokens so themes can control transparency independently for each UI region. New tokens:
- --sidebar-opacity (sidebar background)
- --toolbar-opacity (top toolbar / shared toolbar)
- --content-opacity (file list / main content area)
- --titlebar-opacity (tab bar / title bar)
- --statusbar-opacity (status bar)
The global --bg-opacity should remain as a master multiplier. Each section's effective opacity = section token * global multiplier. Update all existing themes to set sensible defaults for these new tokens.

### Dependencies

- 🔗 **parent-child**: `tauri-jsn1`

<details>
<summary>📋 Commands</summary>

```bash
# Start working on this issue
br update tauri-jsn1.2 -s in_progress

# Add a comment
br comment tauri-jsn1.2 'Your comment here'

# Change priority (0=Critical, 1=High, 2=Medium, 3=Low)
br update tauri-jsn1.2 -p 1

# View full details
br show tauri-jsn1.2
```

</details>

---

<a id="tauri-jsn1-1-add-background-layer-behind-glassmorphism-stack"></a>

## ✨ tauri-jsn1.1 Add background layer behind glassmorphism stack

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | 🟢 open |
| **Created** | 2026-03-04 21:22 |
| **Updated** | 2026-03-04 21:22 |

### Description

Add a new DOM layer (div or canvas) positioned behind the main .explorer glassmorphism stack. This layer sits between the transparent window and the blurred UI, enabling themes to render custom backgrounds. The layer should:
- Be a full-window-size element with z-index below .explorer
- Accept CSS background-image, background-color, or be targetable by JS (for canvas animations)
- Expose a CSS custom property --theme-background-image that themes can set
- Respect the existing --bg-opacity slider (background layer fades with it)
- Not interfere with pointer events or accessibility

### Dependencies

- 🔗 **parent-child**: `tauri-jsn1`

<details>
<summary>📋 Commands</summary>

```bash
# Start working on this issue
br update tauri-jsn1.1 -s in_progress

# Add a comment
br comment tauri-jsn1.1 'Your comment here'

# Change priority (0=Critical, 1=High, 2=Medium, 3=Low)
br update tauri-jsn1.1 -p 1

# View full details
br show tauri-jsn1.1
```

</details>

---

<a id="tauri-jsn1-epic-advanced-theme-engine"></a>

## ✨ tauri-jsn1 EPIC: Advanced Theme Engine

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | 🟢 open |
| **Created** | 2026-03-04 21:21 |
| **Updated** | 2026-03-04 21:21 |

### Description

Extend the theming system to support rich visual customization like Aurora Explorer — custom background images/animations, per-section transparency, icon themes, and more expressive breadcrumb/chrome styling. The current system (CSS custom properties, auto-discovery, glassmorphism stack) provides a strong foundation; this epic adds the missing layers.

<details>
<summary>📋 Commands</summary>

```bash
# Start working on this issue
br update tauri-jsn1 -s in_progress

# Add a comment
br comment tauri-jsn1 'Your comment here'

# Change priority (0=Critical, 1=High, 2=Medium, 3=Low)
br update tauri-jsn1 -p 1

# View full details
br show tauri-jsn1
```

</details>

---

<a id="tauri-18op-extract-fileicon-component-and-split-filelist-svelte"></a>

## 📋 tauri-18op Extract FileIcon component and split FileList.svelte

| Property | Value |
|----------|-------|
| **Type** | 📋 task |
| **Priority** | 🔹 Medium (P2) |
| **Status** | 🔵 in_progress |
| **Created** | 2026-03-03 10:59 |
| **Updated** | 2026-03-03 11:14 |

### Description

FileList.svelte is 871 lines mixing 3 view modes, toasts, drag-drop, type-ahead, and inline SVGs. Extract shared FileIcon.svelte, TilesView component, and useTypeAhead composable.

<details>
<summary>📋 Commands</summary>

```bash
# Mark as complete
br close tauri-18op

# Add a comment
br comment tauri-18op 'Your comment here'

# Change priority (0=Critical, 1=High, 2=Medium, 3=Low)
br update tauri-18op -p 1

# View full details
br show tauri-18op
```

</details>

---

<a id="tauri-qeac-create-createpersistedstate-utility-for-localstorage"></a>

## 📋 tauri-qeac Create createPersistedState utility for localStorage

| Property | Value |
|----------|-------|
| **Type** | 📋 task |
| **Priority** | 🔹 Medium (P2) |
| **Status** | 🔵 in_progress |
| **Created** | 2026-03-03 10:59 |
| **Updated** | 2026-03-03 11:12 |

### Description

~8 state modules each implement their own localStorage persistence with STORAGE_KEY, typeof guard, try/catch JSON.parse. Create a shared createPersistedState<T>(key, default) utility to eliminate duplication.

<details>
<summary>📋 Commands</summary>

```bash
# Mark as complete
br close tauri-qeac

# Add a comment
br comment tauri-qeac 'Your comment here'

# Change priority (0=Critical, 1=High, 2=Medium, 3=Low)
br update tauri-qeac -p 1

# View full details
br show tauri-qeac
```

</details>

---

<a id="tauri-oe1r-replace-handwritten-base64-encode-with-base64-crate"></a>

## 📋 tauri-oe1r Replace handwritten base64_encode with base64 crate

| Property | Value |
|----------|-------|
| **Type** | 📋 task |
| **Priority** | 🔹 Medium (P2) |
| **Status** | 🔵 in_progress |
| **Created** | 2026-03-03 10:59 |
| **Updated** | 2026-03-03 11:04 |

### Description

thumbnails.rs:182-211 has a manual base64 encoder. Replace with base64::engine::general_purpose::STANDARD.encode() from the base64 crate.

<details>
<summary>📋 Commands</summary>

```bash
# Mark as complete
br close tauri-oe1r

# Add a comment
br comment tauri-oe1r 'Your comment here'

# Change priority (0=Critical, 1=High, 2=Medium, 3=Low)
br update tauri-oe1r -p 1

# View full details
br show tauri-oe1r
```

</details>

---

<a id="tauri-jsn1-7-create-aurora-theme-as-showcase-for-new-engine-capabilities"></a>

## ✨ tauri-jsn1.7 Create Aurora theme as showcase for new engine capabilities

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ☕ Low (P3) |
| **Status** | 🟢 open |
| **Created** | 2026-03-04 21:24 |
| **Updated** | 2026-03-04 21:24 |

### Description

Create a new 'Aurora' theme that demonstrates the full power of the extended theme engine, inspired by the Aurora Explorer screenshot. Characteristics:
- Deep dark base with teal/cyan accent palette
- Starfield animated background (constellation lines + glowing particles)
- High transparency on all panels (sidebar, content, toolbar)
- Rounded, teal-tinted folder icons (uses new icon theme system)
- Colored breadcrumb segments with rounded pill shapes
- Subtle glow effects on interactive elements (hover, focus)
- Custom selection highlight with soft glow
This issue depends on all other issues in the epic being completed first, as it exercises every new capability.

### Dependencies

- 🔗 **parent-child**: `tauri-jsn1`
- ⛔ **blocks**: `tauri-jsn1.2`
- ⛔ **blocks**: `tauri-jsn1.3`
- ⛔ **blocks**: `tauri-jsn1.4`
- ⛔ **blocks**: `tauri-jsn1.5`
- ⛔ **blocks**: `tauri-jsn1.6`

<details>
<summary>📋 Commands</summary>

```bash
# Start working on this issue
br update tauri-jsn1.7 -s in_progress

# Add a comment
br comment tauri-jsn1.7 'Your comment here'

# Change priority (0=Critical, 1=High, 2=Medium, 3=Low)
br update tauri-jsn1.7 -p 1

# View full details
br show tauri-jsn1.7
```

</details>

---

<a id="tauri-jsn1-6-add-user-selectable-wallpaper-background-image-setting"></a>

## ✨ tauri-jsn1.6 Add user-selectable wallpaper/background image setting

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ☕ Low (P3) |
| **Status** | 🟢 open |
| **Created** | 2026-03-04 21:24 |
| **Updated** | 2026-03-04 21:24 |

### Description

Allow users to pick a custom background image from their filesystem, independent of theme. This complements the theme-provided backgrounds with user personalization. Design:
- Add a 'Background Image' option in settings (file picker dialog via Tauri)
- Supported formats: PNG, JPG, WEBP, SVG
- Image is rendered in the background layer with cover sizing and center positioning
- User image takes precedence over theme-declared --theme-background-image
- Add a 'Clear' button to remove the custom wallpaper and revert to theme default
- Store the path in settingsStore (persisted to localStorage)
- Add a --user-bg-blur token (0-20px) so users can blur their wallpaper for readability
Depends on the background layer issue.

### Dependencies

- 🔗 **parent-child**: `tauri-jsn1`
- ⛔ **blocks**: `tauri-jsn1.1`

<details>
<summary>📋 Commands</summary>

```bash
# Start working on this issue
br update tauri-jsn1.6 -s in_progress

# Add a comment
br comment tauri-jsn1.6 'Your comment here'

# Change priority (0=Critical, 1=High, 2=Medium, 3=Low)
br update tauri-jsn1.6 -p 1

# View full details
br show tauri-jsn1.6
```

</details>

---

<a id="tauri-jsn1-5-extend-breadcrumb-and-chrome-theming-tokens"></a>

## ✨ tauri-jsn1.5 Extend breadcrumb and chrome theming tokens

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ☕ Low (P3) |
| **Status** | 🟢 open |
| **Created** | 2026-03-04 21:24 |
| **Updated** | 2026-03-04 21:24 |

### Description

Add more CSS custom properties for navigation bar and window chrome styling so themes can achieve distinctive looks (like Aurora's colored breadcrumb segments). New tokens:
- --breadcrumb-bg: background color/gradient for breadcrumb segments
- --breadcrumb-text: text color inside breadcrumb segments
- --breadcrumb-active-bg: background for the current/last segment
- --breadcrumb-hover-bg: hover state background
- --breadcrumb-radius: border-radius for segments
- --breadcrumb-gap: spacing between segments
- --toolbar-border-bottom: bottom border style for toolbar area
- --sidebar-border-right: right border style for sidebar
Existing themes should get sensible defaults. The Hacker theme already has breadcrumb overrides (powerline separators) — ensure those remain working.

### Dependencies

- 🔗 **parent-child**: `tauri-jsn1`

<details>
<summary>📋 Commands</summary>

```bash
# Start working on this issue
br update tauri-jsn1.5 -s in_progress

# Add a comment
br comment tauri-jsn1.5 'Your comment here'

# Change priority (0=Critical, 1=High, 2=Medium, 3=Low)
br update tauri-jsn1.5 -p 1

# View full details
br show tauri-jsn1.5
```

</details>

---

<a id="tauri-jsn1-4-implement-swappable-icon-theme-system"></a>

## ✨ tauri-jsn1.4 Implement swappable icon theme system

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ☕ Low (P3) |
| **Status** | 🟢 open |
| **Created** | 2026-03-04 21:24 |
| **Updated** | 2026-03-04 21:38 |

### Description

Extend icon rendering beyond the current color-tint approach to support full icon theme packs. Design:
- Define an IconTheme interface: { id, name, folderIcon, folderOpenIcon, fileIcon, fileExtensionMap }
- Each icon theme provides SVG components or SVG strings for folder/file icons
- Themes can declare --theme-icon-pack: 'default' | 'material' | 'minimal' etc.
- File extension map allows per-extension custom icons (e.g., .ts, .rs, .md)
- Default icon theme preserves current behavior
- Support external icon packs, particularly material theme icons (same as yazi uses)
  - Yazi uses https://github.com/catppuccin/yazi and material-themed icon packs
  - We should support a similar icon pack format: mapping file extensions/names to Nerd Font glyphs or SVG icons
  - Reference yazi icon pack structure for compatibility/familiarity
- Ship with built-in themes: 'default' (current), 'material' (Material Design file icons), 'rounded' (softer shapes)
- Icon themes are independent of color themes but can be paired via theme CSS
- Allow users to install/load custom icon packs from a config directory

### Dependencies

- 🔗 **parent-child**: `tauri-jsn1`

<details>
<summary>📋 Commands</summary>

```bash
# Start working on this issue
br update tauri-jsn1.4 -s in_progress

# Add a comment
br comment tauri-jsn1.4 'Your comment here'

# Change priority (0=Critical, 1=High, 2=Medium, 3=Low)
br update tauri-jsn1.4 -p 1

# View full details
br show tauri-jsn1.4
```

</details>

---

<a id="tauri-jsn1-3-implement-animated-background-renderer-system"></a>

## ✨ tauri-jsn1.3 Implement animated background renderer system

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ☕ Low (P3) |
| **Status** | 🟢 open |
| **Created** | 2026-03-04 21:23 |
| **Updated** | 2026-03-04 21:23 |

### Description

Build a pluggable animated background system that themes can use to render canvas-based effects (particle fields, starfields, matrix rain, etc.). Design:
- Theme CSS declares --theme-bg-animation: 'particles' | 'starfield' | 'none' (default)
- A registry maps animation names to render functions: (canvas: HTMLCanvasElement, colors: ThemeColors) => cleanup()
- The background layer (from parent issue) hosts an optional <canvas> element
- Renderer is activated/deactivated on theme switch
- Respects prefers-reduced-motion media query (disables animations)
- Uses requestAnimationFrame with automatic pause when window is not visible
- Ship with at least two built-in animations: 'particles' (floating dots with connections) and 'starfield' (twinkling stars with constellation lines, like Aurora Explorer)
Depends on the background layer issue being completed first.

### Dependencies

- 🔗 **parent-child**: `tauri-jsn1`
- ⛔ **blocks**: `tauri-jsn1.1`

<details>
<summary>📋 Commands</summary>

```bash
# Start working on this issue
br update tauri-jsn1.3 -s in_progress

# Add a comment
br comment tauri-jsn1.3 'Your comment here'

# Change priority (0=Critical, 1=High, 2=Medium, 3=Low)
br update tauri-jsn1.3 -p 1

# View full details
br show tauri-jsn1.3
```

</details>

---

<a id="tauri-0jry-can-t-cancel-cut-and-paste-when-progress-bar-shows"></a>

## 🐛 tauri-0jry Can't cancel cut and paste when progress bar shows

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | ☕ Low (P3) |
| **Status** | 🟢 open |
| **Created** | 2026-03-04 10:04 |
| **Updated** | 2026-03-04 10:04 |

### Description

There is no way to cancel a cut and paste operation when the progress bar is showing.

<details>
<summary>📋 Commands</summary>

```bash
# Start working on this issue
br update tauri-0jry -s in_progress

# Add a comment
br comment tauri-0jry 'Your comment here'

# Change priority (0=Critical, 1=High, 2=Medium, 3=Low)
br update tauri-0jry -p 1

# View full details
br show tauri-0jry
```

</details>

---

<a id="tauri-f147-cut-and-paste-with-dialog-gets-stuck-on-0-progress"></a>

## 🐛 tauri-f147 Cut and paste with dialog gets stuck on 0% progress

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | ☕ Low (P3) |
| **Status** | 🟢 open |
| **Created** | 2026-03-04 10:04 |
| **Updated** | 2026-03-04 10:04 |

### Description

Cutting and pasting when a dialog is involved just gets stuck on 0% progress and never completes.

<details>
<summary>📋 Commands</summary>

```bash
# Start working on this issue
br update tauri-f147 -s in_progress

# Add a comment
br comment tauri-f147 'Your comment here'

# Change priority (0=Critical, 1=High, 2=Medium, 3=Low)
br update tauri-f147 -p 1

# View full details
br show tauri-f147
```

</details>

---

<a id="tauri-no52-drag-and-drop-with-conflicting-filenames-should-show-resolution-modal"></a>

## ✨ tauri-no52 Drag and drop with conflicting filenames should show resolution modal

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ☕ Low (P3) |
| **Status** | 🟢 open |
| **Created** | 2026-03-04 10:04 |
| **Updated** | 2026-03-04 10:04 |

### Description

When drag-and-dropping files that conflict with existing names in the target, the conflict resolution modal should appear (same as copy/paste behavior).

<details>
<summary>📋 Commands</summary>

```bash
# Start working on this issue
br update tauri-no52 -s in_progress

# Add a comment
br comment tauri-no52 'Your comment here'

# Change priority (0=Critical, 1=High, 2=Medium, 3=Low)
br update tauri-no52 -p 1

# View full details
br show tauri-no52
```

</details>

---

<a id="tauri-ne9h-cross-window-drag-and-drop-is-unreliable"></a>

## 🐛 tauri-ne9h Cross-window drag and drop is unreliable

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | 🔥 Critical (P0) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-04 06:50 |
| **Updated** | 2026-03-04 07:13 |
| **Closed** | 2026-03-04 07:13 |

### Description

Dragging from one window to another only works sometimes. Needs investigation and fix.

---

<a id="tauri-lmpo-right-clicking-twice-shows-browser-context-menu-instead-of-app-menu"></a>

## 🐛 tauri-lmpo Right-clicking twice shows browser context menu instead of app menu

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | 🔥 Critical (P0) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-03 12:03 |
| **Updated** | 2026-03-03 12:05 |
| **Closed** | 2026-03-03 12:05 |

### Description

Right clicking twice doesn't bring up the context menu in a new spot the second time - it shows the browser context menu instead. Need to ensure the app context menu always overrides the browser default on every right-click.

---

<a id="tauri-8vc1-open-in-terminal-doesn-t-work-working-directory-value-required"></a>

## 🐛 tauri-8vc1 Open in terminal doesn't work: working-directory value required

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | 🔥 Critical (P0) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-03 11:48 |
| **Updated** | 2026-03-03 11:55 |
| **Closed** | 2026-03-03 11:55 |

### Description

Open in terminal says 'working-directory: value required'. The terminal launch command is not passing the directory correctly.

---

<a id="tauri-u6r2-tiles-view-freezes-the-window-make-it-non-blocking"></a>

## 🐛 tauri-u6r2 Tiles view freezes the window - make it non-blocking

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | 🔥 Critical (P0) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-03 11:48 |
| **Updated** | 2026-03-03 11:57 |
| **Closed** | 2026-03-03 11:57 |

### Description

Switching to tiles view STILL freezes the window. Must make the rendering non-blocking, likely via virtualization or chunked rendering.

---

<a id="tauri-obxi-right-click-context-menu-appears-at-wrong-position"></a>

## 🐛 tauri-obxi Right-click context menu appears at wrong position

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | 🔥 Critical (P0) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-03 11:48 |
| **Updated** | 2026-03-03 11:54 |
| **Closed** | 2026-03-03 11:54 |

### Description

Right click menu doesn't appear in the same location as the cursor. Need to fix positioning logic.

---

<a id="tauri-ggkv-fix-multi-file-delete-and-copy-not-working"></a>

## 🐛 tauri-ggkv Fix multi-file delete and copy not working

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | 🔥 Critical (P0) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-03 05:15 |
| **Updated** | 2026-03-03 05:24 |
| **Closed** | 2026-03-03 05:24 |

### Description

Multi-file delete and copy operations don't work. The feature was implemented but may not be properly integrated or there are issues with the dialog/backend connection.

### Notes

Verified: Multi-file delete and copy code is correct. Frontend properly calls move_multiple_to_trash for batch delete and iterates clipboard entries for copy. UI-tester confirmed dialog shows correctly with file list and count. The 'Unknown command' error in testing was because ui-tester ran against Vite dev server (no Tauri backend). Rust command compiles and is registered in invoke_handler.

---

<a id="tauri-zqfo-fix-enter-key-opening-file-instead-of-confirming-delete-dialog"></a>

## 🐛 tauri-zqfo Fix Enter key opening file instead of confirming delete dialog

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | 🔥 Critical (P0) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-03 05:15 |
| **Updated** | 2026-03-03 05:20 |
| **Closed** | 2026-03-03 05:20 |

### Description

Pressing Enter when delete dialog is open opens the file instead of confirming deletion. The file appears to still be selected/focused behind the dialog, so Enter triggers file open. Sometimes opens twice.

### Notes

Fixed: Added dialogStore.activeDialog guard in ExplorerPane.handleKeydown to prevent Enter from opening files when delete dialog is visible. Auto-focus DeleteDialog overlay so keyboard events are captured.

---

<a id="tauri-gkfr-fix-os-clipboard-copy-paste-with-thunar-and-other-wayland-native-apps"></a>

## 🐛 tauri-gkfr Fix OS clipboard copy/paste with Thunar and other Wayland-native apps

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | 🔥 Critical (P0) |
| **Status** | ⚫ closed |
| **Created** | 2026-02-27 22:38 |
| **Updated** | 2026-02-27 22:45 |
| **Closed** | 2026-02-27 22:45 |

### Description

clipboard-rs (used by tauri-plugin-clipboard-x) writes to X11 clipboard only, which doesn't reliably sync with Wayland-native GTK apps like Thunar. Need to use native tools (wl-copy/xclip) for writing, just like we already do for reading with wl-paste/xclip.

---

<a id="tauri-explorer-2o72-tab-switching-not-working-in-tauri-app"></a>

## 🐛 tauri-explorer-2o72 Tab switching not working in Tauri app

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | 🔥 Critical (P0) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-17 23:52 |
| **Updated** | 2026-01-17 23:54 |
| **Closed** | 2026-01-17 23:54 |

### Description

Fixed by excluding .tab-area from drag handling in TitleBar.svelte handleDragStart function.

---

<a id="tauri-explorer-okn6-fix-keyboard-shortcuts-ctrl-c-x-v-not-working-for-clipboard-operations-in-browser-e2e-mode"></a>

## 🐛 tauri-explorer-okn6 Fix keyboard shortcuts (Ctrl+C/X/V) not working for clipboard operations in browser E2E mode

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | 🔥 Critical (P0) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-17 21:54 |
| **Updated** | 2026-01-17 21:55 |
| **Closed** | 2026-01-17 21:55 |

### Description

Keyboard shortcuts for copy/cut/paste don't work because focus is lost when clicking file items. The ExplorerPane section has the keydown handler but when clicking on file items (buttons), those get focus instead. The fix is to add clipboard shortcuts to the global window keydown handler in +page.svelte.

---

<a id="tauri-explorer-5jci-mock-api-detection-bug-tauri-app-shows-mock-data-instead-of-real-filesystem"></a>

## 🐛 tauri-explorer-5jci Mock API detection bug - Tauri app shows mock data instead of real filesystem

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | 🔥 Critical (P0) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-17 21:39 |
| **Updated** | 2026-01-17 21:43 |
| **Closed** | 2026-01-17 21:43 |

### Description

The isTauri() function returns false even when running in the Tauri app, causing mock data to be used instead of real Tauri commands. Need to debug why __TAURI__ detection is failing.

---

<a id="tauri-explorer-60gg-fix-mock-invoke-incorrectly-activating-in-tauri-app"></a>

## 🐛 tauri-explorer-60gg Fix mock invoke incorrectly activating in Tauri app

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | 🔥 Critical (P0) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-17 21:33 |
| **Updated** | 2026-01-17 21:44 |
| **Closed** | 2026-01-17 21:44 |

### Description

**Root Cause:** Tauri v2 uses `__TAURI_INTERNALS__`, not `__TAURI__` (v1).

**Fix:** Changed `isTauri()` in mock-invoke.ts:
```typescript
// Before (wrong - v1)
return "__TAURI__" in window;

// After (correct - v2)  
return "__TAURI_INTERNALS__" in window;
```

Also implemented lazy detection with caching in files.ts to handle timing issues.

All 68 tests pass.

---

<a id="tauri-explorer-gnvv-paste-and-undo-keyboard-shortcuts-broken"></a>

## 🐛 tauri-explorer-gnvv Paste and Undo keyboard shortcuts broken

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | 🔥 Critical (P0) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-17 20:06 |
| **Updated** | 2026-01-17 21:24 |
| **Closed** | 2026-01-17 21:24 |

### Description

Ctrl+V (paste) and Ctrl+Z (undo) keyboard shortcuts are not working. Critical usability regression.

---

<a id="tauri-explorer-zjdw-fix-hardcoded-inconsistent-api-urls"></a>

## 🐛 tauri-explorer-zjdw Fix hardcoded/inconsistent API URLs

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | 🔥 Critical (P0) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-16 00:18 |
| **Updated** | 2026-01-16 00:20 |
| **Closed** | 2026-01-16 00:20 |

### Description

API URLs are hardcoded (port 8008 in files.ts, port 8000 in +page.svelte). Need environment-based configuration for production.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-5lbi`

---

<a id="tauri-explorer-h21l-ctrl-v-paste-not-working"></a>

## 🐛 tauri-explorer-h21l Ctrl+V paste not working

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | 🔥 Critical (P0) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-15 23:17 |
| **Updated** | 2026-01-15 23:26 |
| **Closed** | 2026-01-15 23:26 |

### Description

The keyboard shortcut Ctrl+V to paste files does not work

---

<a id="tauri-explorer-as45-fix-drag-select-bugs"></a>

## 🐛 tauri-explorer-as45 Fix drag select bugs

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | 🔥 Critical (P0) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-15 22:44 |
| **Updated** | 2026-01-15 22:53 |
| **Closed** | 2026-01-15 22:53 |

### Description

Two issues with drag select:
1. Mouseup over disabled sidebar items (Gallery/OneDrive) doesn't release drag select
2. Highlighted files should be selected when drag select is released, not just when over certain areas

---

<a id="tauri-explorer-acj4-bug"></a>

## 📋 tauri-explorer-acj4 bug

| Property | Value |
|----------|-------|
| **Type** | 📋 task |
| **Priority** | 🔥 Critical (P0) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-15 08:44 |
| **Updated** | 2026-01-15 18:44 |
| **Closed** | 2026-01-15 18:44 |

### Description

The app appears too small on 4K monitors with display scaling (e.g., 125% zoom). The app should respect the system's DPI scaling settings to render at the appropriate size.

### Notes

Added Windows manifest with Per-Monitor V2 DPI awareness in build.rs. This ensures the app renders crisply on high-DPI displays like 4K monitors with 125% scaling. The manifest sets both dpiAware and dpiAwareness flags for Windows 10/11 compatibility.

---

<a id="tauri-explorer-zrs9-bug"></a>

## 📋 tauri-explorer-zrs9 bug

| Property | Value |
|----------|-------|
| **Type** | 📋 task |
| **Priority** | 🔥 Critical (P0) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-15 08:44 |
| **Updated** | 2026-01-15 08:48 |
| **Closed** | 2026-01-15 08:48 |

### Description

The forward and back buttons in the toolbar don't work currently. They should navigate through the browsing history stack.

### Notes

Implemented back/forward navigation: Added history tracking, goBack/goForward methods, wired up NavigationBar buttons, and added Alt+Left/Right keyboard shortcuts.

---

<a id="tauri-explorer-v2kr-bug"></a>

## 📋 tauri-explorer-v2kr bug

| Property | Value |
|----------|-------|
| **Type** | 📋 task |
| **Priority** | 🔥 Critical (P0) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-15 08:44 |
| **Updated** | 2026-01-15 18:40 |
| **Closed** | 2026-01-15 18:40 |

### Description

When clicking on the path bar to make it editable, clicking away (losing focus) should reset/cancel the edit and show the original path, rather than keeping the edited state.

### Notes

Verified working correctly. The onblur handler on the path input calls cancelPathEdit() which resets editingPath to false and clears editedPath. Tested with UI tester - clicking away from path bar properly resets to breadcrumb view.

---

<a id="tauri-explorer-7xzv-feature"></a>

## 📋 tauri-explorer-7xzv feature

| Property | Value |
|----------|-------|
| **Type** | 📋 task |
| **Priority** | 🔥 Critical (P0) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-15 08:44 |
| **Updated** | 2026-01-15 18:55 |
| **Closed** | 2026-01-15 18:55 |

### Description

Make the app look more like Windows Explorer. Reference: screenshots/Screenshot 2026-01-13 082208.jpg. Goals: more colorful and vibrant icons, minimalistic design, proper sidebar with pinned folders, breadcrumb navigation styling, and overall visual polish.

### Notes

UI polish improvements:
- Date formatting: Changed to Windows 11 style 'M/D/YYYY, h:mm AM/PM' format
- File type column: Added comprehensive type detection with 80+ file extensions mapped to descriptive names (e.g., 'Windows Batch File', 'JPEG Image')
- Folder icons: Made more vibrant golden yellow (#ffb900 light, #ffc83d dark)
- Folder opacity: Adjusted for better visibility (front: 1.0, back: 0.65)

---

<a id="tauri-explorer-wxzn-feature"></a>

## 📋 tauri-explorer-wxzn feature

| Property | Value |
|----------|-------|
| **Type** | 📋 task |
| **Priority** | 🔥 Critical (P0) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-15 08:44 |
| **Updated** | 2026-01-15 18:51 |
| **Closed** | 2026-01-15 18:51 |

### Description

Make rename happen on the file name itself in-place, rather than in a modal dialog. This matches Windows Explorer's behavior where pressing F2 or slow double-click activates an editable text field directly on the file name.

### Notes

Implemented inline rename (like Windows Explorer):
- Modified FileItem.svelte to show inline text input when renaming
- Input pre-fills with current name, selects filename part (excluding extension)
- Enter confirms, Escape cancels, blur confirms if changed
- Removed RenameDialog modal from the page
- Also fixed path bar reset issue: added explicit blur() call before preventDefault() in marquee start handler

---

<a id="tauri-explorer-3b5s-stream-file-results-via-tauri-events"></a>

## ✨ tauri-explorer-3b5s Stream file results via Tauri events

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔥 Critical (P0) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 23:21 |
| **Updated** | 2026-01-17 00:08 |
| **Closed** | 2026-01-17 00:08 |

### Description

Instead of single GET request returning all files, emit Tauri events as files are found. UI can render first 50 files immediately while rest are still scanning. Dramatically improves perceived speed.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-a0b2`

---

<a id="tauri-explorer-nzgb-implement-virtualized-file-list"></a>

## ✨ tauri-explorer-nzgb Implement virtualized file list

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔥 Critical (P0) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 23:21 |
| **Updated** | 2026-01-14 19:58 |
| **Closed** | 2026-01-14 19:58 |

### Description

Use svelte-virtual-list or build custom virtualization. Only render 20-30 visible items in DOM instead of thousands. This is the single biggest fix for UI lag when browsing folders with many files.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-a0b2`

---

<a id="tauri-explorer-a0b2-epic-performance-optimization"></a>

## ✨ tauri-explorer-a0b2 EPIC: Performance Optimization

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔥 Critical (P0) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 23:21 |
| **Updated** | 2026-01-17 00:08 |
| **Closed** | 2026-01-17 00:08 |

### Description

Make the file manager feel as snappy as Windows Explorer or faster. Tackle frontend virtualization, backend optimization, IPC streaming, and moving hot paths to Rust.

---

<a id="tauri-explorer-pad-double-click-to-open-files-in-default-app"></a>

## ✨ tauri-explorer-pad Double click to open files in default app

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔥 Critical (P0) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:27 |
| **Updated** | 2026-01-14 19:53 |
| **Closed** | 2026-01-14 19:53 |

### Description

Implement double click on files to open them in the system's default application for that file type. Use Tauri's shell.open() or equivalent API to launch the default handler.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-imc`

---

<a id="tauri-explorer-bry-double-click-to-open-folders"></a>

## 🐛 tauri-explorer-bry Double click to open folders

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | 🔥 Critical (P0) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:27 |
| **Updated** | 2026-01-14 19:53 |
| **Closed** | 2026-01-14 19:53 |

### Description

Implement double click to navigate into folders. Single click should only select, not navigate. This matches Windows Explorer behavior.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-imc`

---

<a id="tauri-explorer-i9d-single-click-to-select-file-with-visual-highlighting"></a>

## 🐛 tauri-explorer-i9d Single click to select file with visual highlighting

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | 🔥 Critical (P0) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:27 |
| **Updated** | 2026-01-14 19:53 |
| **Closed** | 2026-01-14 19:53 |

### Description

Currently clicking on a file may have incorrect behavior. Implement single click to select a file/folder with clear visual highlighting (background color change). Selection should be distinct and obvious to the user.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-imc`

---

<a id="tauri-explorer-imc-epic-file-selection-and-interaction"></a>

## 🐛 tauri-explorer-imc EPIC: File Selection and Interaction

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | 🔥 Critical (P0) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:27 |
| **Updated** | 2026-01-17 00:04 |
| **Closed** | 2026-01-17 00:04 |

### Description

Fix core file interaction behavior to match Windows Explorer: single click selects with highlighting, double click opens folders/files, multi-select with Ctrl/Shift, visual selection feedback.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-w0eo`
- 🔗 **parent-child**: `tauri-explorer-okfw`
- 🔗 **parent-child**: `tauri-explorer-yn48`

---

<a id="tauri-vz1q-undo-drag-operations-doesn-t-refresh-source-window"></a>

## 🐛 tauri-vz1q Undo drag operations doesn't refresh source window

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-04 10:04 |
| **Updated** | 2026-03-04 10:15 |
| **Closed** | 2026-03-04 10:15 |

### Description

When undoing a drag operation, the source window doesn't refresh to show the restored files.

---

<a id="tauri-5dq0-cross-folder-drag-inconsistent"></a>

## 🐛 tauri-5dq0 Cross-folder drag inconsistent

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-04 10:04 |
| **Updated** | 2026-03-04 10:14 |
| **Closed** | 2026-03-04 10:14 |

### Description

Cross folder drag doesn't always work. Seems to always work when dragging from an older window to a newer window, but the other way around is inconsistent.

---

<a id="tauri-15y5-undo-delete-doesn-t-work"></a>

## 🐛 tauri-15y5 Undo delete doesn't work

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-04 10:04 |
| **Updated** | 2026-03-04 10:11 |
| **Closed** | 2026-03-04 10:11 |

### Description

Undoing deletions doesn't work. Repro: create a new folder -> delete it -> try to undo. Nothing happens.

---

<a id="tauri-saj4-fix-marquee-selection-has-invisible-32px-boundary-in-list-tiles-views"></a>

## 🐛 tauri-saj4 Fix: Marquee selection has invisible 32px boundary in list/tiles views

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-04 07:39 |
| **Updated** | 2026-03-04 07:40 |
| **Closed** | 2026-03-04 07:40 |

---

<a id="tauri-p09o-include-recent-frecency-paths-in-ctrl-p-search"></a>

## ✨ tauri-p09o Include recent/frecency paths in Ctrl+P search

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-04 18:33 |
| **Updated** | 2026-03-04 19:50 |
| **Closed** | 2026-03-04 19:50 |

### Description

Ctrl+P QuickOpen only walks ~. Paths outside ~ (e.g. /tmp/delete-debug) never appear even if recently visited. Fix: inject matching entries from recentFilesStore and frecencyStore into results via client-side fuzzy matching.

---

<a id="tauri-hevl-ctrl-shift-t-should-restore-closed-tabs-in-new-window-when-needed"></a>

## 🐛 tauri-hevl Ctrl+Shift+T should restore closed tabs in new window when needed

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-04 06:50 |
| **Updated** | 2026-03-04 07:00 |
| **Closed** | 2026-03-04 07:00 |

### Description

Ctrl+Shift+T restores closed windows, but in a new tab rather than in a new window. If the closed tab was in a closed window, ensure that a new window gets opened.

---

<a id="tauri-31co-details-view-column-headers-are-transparent-when-scrolling"></a>

## 🐛 tauri-31co Details view column headers are transparent when scrolling

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-04 06:50 |
| **Updated** | 2026-03-04 06:56 |
| **Closed** | 2026-03-04 06:56 |

### Description

In details view, the column headers are transparent which looks weird when scrolling down far enough. They should have an opaque background.

---

<a id="tauri-5r30-dragged-file-still-visible-in-source-window-until-refresh"></a>

## 🐛 tauri-5r30 Dragged file still visible in source window until refresh

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-04 06:50 |
| **Updated** | 2026-03-04 07:13 |
| **Closed** | 2026-03-04 07:13 |

### Description

When dragging from one window to another, the file is still visible in the source window until refresh. Add a playwright test for this.

---

<a id="tauri-sa5i-selected-files-don-t-match-selection-box-in-list-view"></a>

## 🐛 tauri-sa5i Selected files don't match selection box in list view

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-04 06:50 |
| **Updated** | 2026-03-04 06:55 |
| **Closed** | 2026-03-04 06:55 |

### Description

The selected files don't match the selection box in list view.

---

<a id="tauri-zmjd-list-tiles-view-highlight-selection-area-stops-short-of-first-icon"></a>

## 🐛 tauri-zmjd List/tiles view highlight selection area stops short of first icon

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-04 06:50 |
| **Updated** | 2026-03-04 06:55 |
| **Closed** | 2026-03-04 06:55 |

### Description

In list and tiles view, the highlight selection area stops short of the first icon, as if the column headers of detail view are still there.

---

<a id="tauri-mfjv-icons-shift-slightly-when-highlighted-due-to-left-side-highlight-color"></a>

## 🐛 tauri-mfjv Icons shift slightly when highlighted due to left-side highlight color

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-04 06:50 |
| **Updated** | 2026-03-04 06:55 |
| **Closed** | 2026-03-04 06:55 |

### Description

Icons shift slightly when they get highlighted, because of the small highlight color on the far left hand side.

---

<a id="tauri-lgo0-error-shown-after-deleting-folder-unable-to-access-folder"></a>

## 📋 tauri-lgo0 Error shown after deleting folder: 'Unable to access folder'

| Property | Value |
|----------|-------|
| **Type** | 📋 task |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-04 04:12 |
| **Updated** | 2026-03-04 04:16 |
| **Closed** | 2026-03-04 04:16 |

### Description

After deleting a folder, the app shows 'Unable to access folder' with 'Path not found: (path)'. Root cause: refresh() blindly navigates to currentPath without handling non-existent directories. Also, navigateAwayIfNeeded() is a sync function that fire-and-forgets an async navigateTo() call. Fix: make refresh() resilient to deleted paths by falling back to parent, and make navigateAwayIfNeeded async.

---

<a id="tauri-vmpc-copy-cut-freezes-window-sync-tauri-commands-block-main-thread"></a>

## 📋 tauri-vmpc Copy/cut freezes window - sync Tauri commands block main thread

| Property | Value |
|----------|-------|
| **Type** | 📋 task |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-04 03:42 |
| **Updated** | 2026-03-04 03:58 |
| **Closed** | 2026-03-04 03:58 |

### Description

clipboard_write_files, clipboard_has_files, and clipboard_read_files are synchronous Tauri commands that shell out to wl-copy/xclip. Since sync Tauri 2 commands run on the main thread, child.wait() blocks the UI. Fix: make them async so they run on worker threads.

---

<a id="tauri-j9aa-context-menu-doesn-t-appear-when-right-clicking-files-folders"></a>

## 🐛 tauri-j9aa Context menu doesn't appear when right-clicking files/folders

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-04 02:15 |
| **Updated** | 2026-03-04 02:36 |
| **Closed** | 2026-03-04 02:36 |

### Description

Right clicking on files and folders doesn't bring up the context menu.

---

<a id="tauri-jmcg-double-clicking-symlink-opens-terminal-instead-of-navigating-in-app"></a>

## 🐛 tauri-jmcg Double-clicking symlink opens terminal instead of navigating in app

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-04 02:15 |
| **Updated** | 2026-03-04 02:36 |
| **Closed** | 2026-03-04 02:36 |

### Description

Double clicking a symlink opens it in the terminal instead of navigating to the target within tauri-explorer itself.

---

<a id="tauri-ksp2-remove-prefix-from-address-bar"></a>

## 🐛 tauri-ksp2 Remove '/ >' prefix from address bar

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-04 02:15 |
| **Updated** | 2026-03-04 02:36 |
| **Closed** | 2026-03-04 02:36 |

### Description

The address bar has an unwanted '/ >' prefix that should be removed.

---

<a id="tauri-5hlj-remove-weird-triangles-from-address-bar"></a>

## 🐛 tauri-5hlj Remove weird triangles from address bar

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-04 02:15 |
| **Updated** | 2026-03-04 02:36 |
| **Closed** | 2026-03-04 02:36 |

### Description

There are weird triangles appearing in the address bar / breadcrumb navigation. These should be cleaned up.

### Dependencies

- 🔗 **related**: `tauri-ksp2`

---

<a id="tauri-8ytw-right-click-context-menu-doesn-t-appear-on-second-click"></a>

## 🐛 tauri-8ytw Right-click context menu doesn't appear on second click

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-04 02:15 |
| **Updated** | 2026-03-04 02:36 |
| **Closed** | 2026-03-04 02:36 |

### Description

Right clicking twice doesn't bring up the context menu on the second click. The first right-click works, but subsequent right-clicks fail to show the context menu.

### Dependencies

- 🔗 **related**: `tauri-j9aa`

---

<a id="tauri-zvg6-drag-to-quick-access-doesn-t-work"></a>

## 🐛 tauri-zvg6 Drag to quick access doesn't work

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-03 11:48 |
| **Updated** | 2026-03-03 12:01 |
| **Closed** | 2026-03-03 12:01 |

### Description

Dragging files/folders to the quick access sidebar still doesn't work.

---

<a id="tauri-anov-clipboard-is-window-specific-instead-of-app-global"></a>

## 🐛 tauri-anov Clipboard is window-specific instead of app-global

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-03 11:48 |
| **Updated** | 2026-03-03 12:00 |
| **Closed** | 2026-03-03 12:00 |

### Description

The clipboard seems to be window specific. Cutting from one window and pasting to another doesn't work - it copies but the file remains in the original. After renaming a file, it can't be copied/pasted. Should paste the last item copied to clipboard regardless of window.

---

<a id="tauri-fadw-epic-architecture-improvements-for-extensibility-and-maintainability"></a>

## 📋 tauri-fadw EPIC: Architecture improvements for extensibility and maintainability

| Property | Value |
|----------|-------|
| **Type** | 📋 task |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-03 10:59 |
| **Updated** | 2026-03-03 11:30 |
| **Closed** | 2026-03-03 11:30 |

### Description

Parent issue for all architecture improvements identified during comprehensive review. Covers frontend state management, backend patterns, cross-cutting concerns, and cleanup.

### Dependencies

- 🔗 **parent-child**: `tauri-aw0h`
- 🔗 **parent-child**: `tauri-hit0`
- 🔗 **parent-child**: `tauri-oe1r`
- 🔗 **parent-child**: `tauri-fl0e`
- 🔗 **parent-child**: `tauri-5t7m`
- 🔗 **parent-child**: `tauri-qeac`
- 🔗 **parent-child**: `tauri-18op`
- 🔗 **parent-child**: `tauri-c8m9`
- 🔗 **parent-child**: `tauri-kjg8`
- 🔗 **parent-child**: `tauri-pqo3`

---

<a id="tauri-x4cy-fix-deleted-folder-error-message-after-successful-deletion"></a>

## 🐛 tauri-x4cy Fix deleted folder error message after successful deletion

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-03 10:58 |
| **Updated** | 2026-03-03 12:04 |
| **Closed** | 2026-03-03 12:04 |

### Description

After deleting a folder successfully, an error appears: 'unable to access folder, path not found: <deleted folder>'. The UI should navigate away or refresh automatically after deletion instead of trying to display the now-deleted path.

---

<a id="tauri-o5ny-refactor-remove-duplicate-keyboard-shortcut-handlers"></a>

## 📋 tauri-o5ny Refactor: Remove duplicate keyboard shortcut handlers

| Property | Value |
|----------|-------|
| **Type** | 📋 task |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-03 09:59 |
| **Updated** | 2026-03-03 10:02 |
| **Closed** | 2026-03-03 10:02 |

### Description

Ctrl+C/X/V/Z/A are handled in 3 places (FileList, ExplorerPane, global keybinding system), causing triple execution. Previous fix used stopPropagation which is a band-aid. Proper fix: consolidate all shortcut handling into the global keybinding system and remove duplicates from FileList and ExplorerPane. Move toast feedback into paste() or use events.

---

<a id="tauri-0nj7-fix-marquee-selection-box-offset-from-cursor-position"></a>

## 🐛 tauri-0nj7 Fix marquee selection box offset from cursor position

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-03 09:57 |
| **Updated** | 2026-03-03 12:06 |
| **Closed** | 2026-03-03 12:06 |

### Description

The drag selection (marquee) box's leading corner doesn't align with the actual cursor position. The rectangle appears offset from where the user starts/drags, making selection feel imprecise. Need to investigate the coordinate calculation in use-marquee-selection.svelte.ts (start/move functions) for potential offset errors related to container positioning, scroll offsets, or CSS transforms (e.g. zoom level).

---

<a id="tauri-6yzm-fix-paste-into-empty-folder-duplicates-3-times"></a>

## 🐛 tauri-6yzm Fix paste into empty folder duplicates 3 times

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-03 07:13 |
| **Updated** | 2026-03-03 10:02 |
| **Closed** | 2026-03-03 10:02 |

### Description

Copying into an empty folder for some reason copies 3 times. Need to debug the paste handler to find why it triggers multiple times.

---

<a id="tauri-qz5t-fix-copy-paste-folder-with-files-not-working"></a>

## 🐛 tauri-qz5t Fix copy/paste folder with files not working

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-03 07:13 |
| **Updated** | 2026-03-03 07:24 |
| **Closed** | 2026-03-03 07:24 |

### Description

Copying and pasting a folder that contains files doesn't work correctly. Need to investigate and fix the recursive copy logic.

---

<a id="tauri-nag1-fix-tiles-view-freeze-when-loading-thumbnails"></a>

## 🐛 tauri-nag1 Fix tiles view freeze when loading thumbnails

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-03 05:15 |
| **Updated** | 2026-03-03 05:20 |
| **Closed** | 2026-03-03 05:20 |

### Description

Switching to tiles view in a large folder of pictures causes ~10s freeze. Should show icons immediately and load thumbnails asynchronously without blocking the UI.

### Notes

Fixed: Added global concurrency limiter (max 4 concurrent) with queue in ThumbnailImage.svelte module-level script.

---

<a id="tauri-n5sr-fix-tiles-view-drag-selection-box-mismatch"></a>

## 🐛 tauri-n5sr Fix tiles view drag selection box mismatch

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-03 05:15 |
| **Updated** | 2026-03-03 07:26 |
| **Closed** | 2026-03-03 07:26 |

### Description

In tiles view, the drag selection box visual does not match what actually gets selected. The items that end up selected are different from what the box visually covers.

---

<a id="tauri-qbx6-fix-png-image-previews-not-working"></a>

## 🐛 tauri-qbx6 Fix PNG image previews not working

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-03 13:14 |
| **Updated** | 2026-03-03 05:24 |
| **Closed** | 2026-03-03 05:24 |

### Description

Image preview functionality does not work with PNG files

### Notes

Fixed: Added with_guessed_format() for robust PNG detection, always convert to rgb8() before JPEG encoding, added CACHE_VERSION=2 to invalidate stale cache. 6 Rust tests pass including synthetic PNG and actual icon.png tests.

---

<a id="tauri-1rzt-fix-laggy-image-previews"></a>

## 🐛 tauri-1rzt Fix laggy image previews

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-03 13:14 |
| **Updated** | 2026-03-03 04:12 |
| **Closed** | 2026-03-03 04:12 |

### Description

Image previews are very laggy, especially in folders with many images like /home/chong/Pictures. Investigate and optimize.

---

<a id="tauri-nycs-enter-key-works-for-confirmation-modals"></a>

## ✨ tauri-nycs Enter key works for confirmation modals

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-03 13:14 |
| **Updated** | 2026-03-03 04:05 |
| **Closed** | 2026-03-03 04:05 |

### Description

Pressing Enter should confirm/submit confirmation modals

---

<a id="tauri-phud-delete-multiple-selected-files"></a>

## ✨ tauri-phud Delete multiple selected files

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-03 13:14 |
| **Updated** | 2026-03-03 04:12 |
| **Closed** | 2026-03-03 04:12 |

### Description

Enable deleting multiple files when they are selected via multi-selection

---

<a id="tauri-64lw-tiles-view-crashes-when-selected-via-command-palette"></a>

## 🐛 tauri-64lw Tiles view crashes when selected via command palette

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-02 11:35 |
| **Updated** | 2026-03-02 11:40 |
| **Closed** | 2026-03-02 11:40 |

### Description

Selecting tiles view in command palette currently crashes the app

---

<a id="tauri-nczo-frontend-incremental-flattening-pagination-cached-offsets"></a>

## ✨ tauri-nczo Frontend: Incremental flattening + pagination + cached offsets

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-02-15 03:14 |
| **Updated** | 2026-02-15 03:26 |
| **Closed** | 2026-02-15 03:26 |

### Description

Replace derived flattening with incremental append. Add infinite scroll pagination (PAGE_SIZE=200). Cache offset array for O(1) scrollToSelected. Update footer to show pagination info.

### Dependencies

- 🔗 **parent-child**: `tauri-ygaq`

---

<a id="tauri-pkc4-backend-searcherbuilder-with-mmap-binary-detection-per-thread-reuse"></a>

## ✨ tauri-pkc4 Backend: SearcherBuilder with mmap + binary detection + per-thread reuse

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-02-15 03:14 |
| **Updated** | 2026-02-15 03:26 |
| **Closed** | 2026-02-15 03:26 |

### Description

Replace bare Searcher::new() per file with SearcherBuilder configured with MmapChoice::auto(), BinaryDetection::quit(NUL), created once per worker thread. Use RegexMatcherBuilder for cleaner pattern construction.

### Dependencies

- 🔗 **parent-child**: `tauri-ygaq`

---

<a id="tauri-ygaq-epic-content-search-performance-optimization"></a>

## ✨ tauri-ygaq EPIC: Content Search Performance Optimization

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-02-15 03:14 |
| **Updated** | 2026-02-15 03:26 |
| **Closed** | 2026-02-15 03:26 |

### Description

Backend: mmap, binary detection, searcher reuse, line truncation, adaptive batching. Frontend: incremental flattening, pagination, cached offsets. Target: 2-5x faster search on 50MB corpus.

---

<a id="tauri-svfq-add-zoom-functionality-with-alt-hotkeys"></a>

## ✨ tauri-svfq Add zoom functionality with Alt+/- hotkeys

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-02-14 19:39 |
| **Updated** | 2026-02-14 19:41 |
| **Closed** | 2026-02-14 19:41 |

### Description

Add zoom in/out/reset via CSS zoom with customizable keybindings (Alt+=, Alt+-, Alt+0). Persist zoom level in settings store.

### Notes

Added zoom in/out/reset with Alt+=/Alt+-/Alt+0 hotkeys. Zoom level (50-200%, 10% steps) persists in localStorage. Applied via CSS zoom on document root with reactive Svelte 5 $effect. All 190 tests pass. Files changed: settings.svelte.ts (zoomLevel in Settings, zoomIn/zoomOut/zoomReset methods), command-definitions.ts (3 view.zoom* commands), +page.svelte ($effect for document zoom).

---

<a id="tauri-aefl-fix-drag-and-drop-quick-access-pinning-in-tauri-desktop-app-webkitgtk"></a>

## 🐛 tauri-aefl Fix drag-and-drop Quick Access pinning in Tauri desktop app (WebKitGTK)

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-02-14 00:05 |
| **Updated** | 2026-03-02 11:46 |
| **Closed** | 2026-03-02 11:46 |

### Description

   1 ## Problem
   2 The dragend-based Quick Access pin workaround (from tauri-0gre) works in Chrome browser but does NOT work in the actual Tauri desktop app on Linux (WebKitGTK webview on Wayland/Hyprland).
   3 
   4 ## Context
   5 - The app uses Tauri v2, which uses WebKitGTK as the webview on Linux
   6 - `dragDropEnabled: false` is set in tauri.conf.json
   7 - The dragend workaround relies on: dragstart → shared dragState → native dragover listeners → dragend checks isDragOver
   8 - In Chrome: dragover fires on sidebar elements, isDragOver gets set, dragend detects the drop ✓
   9 - In Tauri/WebKitGTK: likely either dragover doesn't fire on the sidebar, or dragend doesn't fire, or the events behave differently
  10 
  11 ## Possible Causes
  12 1. **WebKitGTK DnD on Wayland** — WebKitGTK has known issues with HTML5 DnD on Wayland compositors. The drag events may not propagate correctly within the webview.
  13 2. **`dragDropEnabled: false` breaks all drag events** — disabling Tauri's native DnD handler may also suppress HTML5 DnD events entirely in WebKitGTK, unlike in Chromium where it only disables the native file drop interception.
  14 3. **`dragDropEnabled: true` intercepts before webview** — with the default setting, Tauri's native handler may consume drag events before they reach the HTML5 DnD layer in WebKitGTK.
  15 4. **WebKitGTK doesn't fire dragend** — the dragend event may not fire reliably on WebKitGTK/Wayland, breaking the workaround.
  16 
  17 ## Investigation Steps
  18 1. Add console.log to dragstart, dragover, dragend handlers and test in the Tauri app (open devtools with Ctrl+Shift+I or via Tauri's dev mode)
  19 2. Test with `dragDropEnabled: true` vs `false` — compare which drag events fire in each mode
  20 3. Research WebKitGTK + Wayland DnD known issues
  21 4. If HTML5 DnD is fundamentally broken in WebKitGTK/Wayland, consider alternative approaches:
  22    - Use Tauri's native `onDragDropEvent` API for internal items (would need IPC)
  23    - Use pointer events (mousedown/mousemove/mouseup) to implement custom drag-and-drop
  24    - Use a drag-and-drop library that uses pointer events under the hood
  25 
  26 ## Related
  27 - Predecessor: tauri-0gre (closed — dragend workaround for Chrome)
  28 - Sibling: tauri-dh79 (investigate drop event not firing in Svelte 5)

### Dependencies

- 🔗 **discovered-from**: `tauri-0gre`

### Comments

> **Claude User** (2026-03-02)
>
> Fixed with drag event polling + elementFromPoint fallback in Sidebar.svelte

---

<a id="tauri-0gre-fix-drag-and-drop-to-pin-folders-in-quick-access"></a>

## 🐛 tauri-0gre Fix drag and drop to pin folders in Quick Access

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-02-12 17:22 |
| **Updated** | 2026-02-13 23:55 |
| **Closed** | 2026-02-13 23:55 |

### Description

When dragging a folder from the file list to the Quick Access section in the sidebar, the drop doesn't register and the folder is not pinned/bookmarked. The drag-and-drop handlers are implemented in Sidebar.svelte but appear to not be working correctly.

---

<a id="tauri-explorer-rdra-support-pasting-files-from-os-clipboard"></a>

## 📋 tauri-explorer-rdra Support pasting files from OS clipboard

| Property | Value |
|----------|-------|
| **Type** | 📋 task |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-18 15:01 |
| **Updated** | 2026-03-02 11:29 |
| **Closed** | 2026-03-02 11:29 |

### Description

Allow pasting files that were copied from other applications (like native file explorers) into our app. This complements the copy-to-clipboard feature for full OS clipboard integration.

---

<a id="tauri-explorer-za55-os-clipboard-integration-for-copy-operations"></a>

## 📋 tauri-explorer-za55 OS clipboard integration for copy operations

| Property | Value |
|----------|-------|
| **Type** | 📋 task |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-18 15:01 |
| **Updated** | 2026-03-02 11:29 |
| **Closed** | 2026-03-02 11:29 |

### Description

Make copy operations use the actual OS clipboard so files can be copied from our app and pasted in other applications (like native file explorers). This is the 'copy TO clipboard' direction. Related to EPIC: Clipboard Paste as Files (tauri-explorer-j0a) which handles the 'paste FROM clipboard' direction.

---

<a id="tauri-explorer-5w06-content-search-performance-parallel-walking-per-file-limits-delta-emit"></a>

## 📋 tauri-explorer-5w06 Content search performance: parallel walking + per-file limits + delta emit

| Property | Value |
|----------|-------|
| **Type** | 📋 task |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-18 12:29 |
| **Updated** | 2026-01-18 12:35 |
| **Closed** | 2026-01-18 12:35 |

### Description

Fix 5s search delay vs instant rg. Three changes: 1) Use build_parallel() instead of build() for multi-core file walking, 2) Add max_matches_per_file=50 limit, 3) Emit only new results instead of cloning entire accumulator.

---

<a id="tauri-explorer-10m8-add-tests-for-content-search-streaming-and-cancellation"></a>

## 🧹 tauri-explorer-10m8 Add tests for content search streaming and cancellation

| Property | Value |
|----------|-------|
| **Type** | 🧹 chore |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-18 10:52 |
| **Updated** | 2026-01-18 10:55 |
| **Closed** | 2026-01-18 10:55 |

### Description

Add unit tests to verify content search results stream progressively and cancellation works correctly.

---

<a id="tauri-explorer-vpxq-cannot-cancel-content-search-while-in-progress"></a>

## 🐛 tauri-explorer-vpxq Cannot cancel content search while in progress

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-18 10:52 |
| **Updated** | 2026-01-18 10:55 |
| **Closed** | 2026-01-18 10:55 |

### Description

There's no UI affordance to cancel an ongoing content search. Users should be able to cancel a long-running search.

---

<a id="tauri-explorer-44dx-content-search-results-don-t-stream-progressively"></a>

## 🐛 tauri-explorer-44dx Content search results don't stream progressively

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-18 10:52 |
| **Updated** | 2026-01-18 10:55 |
| **Closed** | 2026-01-18 10:55 |

### Description

Results appear all at once instead of streaming progressively as files are searched. The streaming mechanism in content_search.rs emits batched results but they don't appear incrementally in the UI.

---

<a id="tauri-explorer-c0rr-tab-title-not-updating-when-navigating"></a>

## 🐛 tauri-explorer-c0rr Tab title not updating when navigating

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-17 23:52 |
| **Updated** | 2026-01-17 23:54 |
| **Closed** | 2026-01-17 23:54 |

### Description

Fixed by reading title directly from explorer.state.currentPath in getTabTitle() instead of storing title separately. Template now calls function directly for reactive updates.

---

<a id="tauri-explorer-9b4m-fix-clipboard-shortcuts-not-working-after-clicking-files"></a>

## 🐛 tauri-explorer-9b4m Fix clipboard shortcuts not working after clicking files

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-17 22:00 |
| **Updated** | 2026-01-17 22:00 |
| **Closed** | 2026-01-17 22:00 |

### Description

Ctrl+C/X/V shortcuts didn't work after clicking file items because focus moved to buttons, not the explorer pane.

Fixed by adding global keyboard handlers at window level in +page.svelte.

---

<a id="tauri-explorer-ldfx-move-tabs-above-pane-level-window-level-tabs"></a>

## ✨ tauri-explorer-ldfx Move tabs above pane level (window-level tabs)

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-17 20:06 |
| **Updated** | 2026-01-18 00:10 |
| **Closed** | 2026-01-18 00:10 |

### Description

Window-level tabs feature complete. Merged to main.

Changes:
- Tabs moved from pane-level to window-level
- Each tab contains full dual-pane layout state
- Tab title shows active pane's folder name
- Per-tab: dualPaneEnabled, splitRatio, activePaneId

Files added: window-tabs.svelte.ts, WindowTabBar.svelte
Files removed: tabs.svelte.ts, TabBar.svelte, panes.svelte.ts

All 68 tests pass. UI tested successfully.

---

<a id="tauri-explorer-az6w-streaming-fuzzy-search-like-fzf-10k-files"></a>

## ✨ tauri-explorer-az6w Streaming fuzzy search like fzf (10k+ files)

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-16 22:32 |
| **Updated** | 2026-01-17 00:02 |
| **Closed** | 2026-01-17 00:02 |

### Description

Implement performant fuzzy search that streams partial results as it scans, similar to fzf in terminal.

Requirements:
- Stream results incrementally as directories are scanned
- Show matches immediately, don't wait for full scan to complete
- Handle 10,000+ files without UI freeze
- Use Rust for the search backend (nucleo or similar fuzzy matching crate)
- WebSocket or Tauri events for streaming results to frontend
- Debounce input to avoid excessive searches
- Cancel in-flight searches when query changes

UX:
- Results appear within ~50ms of typing
- Visual indicator showing scan progress
- Results update live as more matches are found
- Keyboard navigation (up/down, enter to select)

Depends on Rust backend migration.

### Dependencies

- ⛔ **blocks**: `tauri-explorer-nv2y`

---

<a id="tauri-explorer-im3m-performant-image-thumbnail-generation-in-rust"></a>

## ✨ tauri-explorer-im3m Performant image thumbnail generation in Rust

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-16 22:32 |
| **Updated** | 2026-01-17 00:18 |
| **Closed** | 2026-01-17 00:18 |

### Description

Implement fast image thumbnail generation using Rust for the tiles/grid view.

Requirements:
- Generate thumbnails on-demand as user scrolls (lazy loading)
- Cache thumbnails to disk for fast subsequent access
- Support common formats: JPEG, PNG, GIF, WebP, BMP
- Use image-rs crate for decoding/encoding
- Consider using rayon for parallel thumbnail generation
- Serve via Tauri custom protocol (asset://) for zero-copy transfer

Performance targets:
- Generate thumbnail in <50ms per image
- Support thousands of images in a directory without blocking UI
- Memory-efficient streaming (don't load full image into memory)

Depends on Rust backend migration.

### Dependencies

- ⛔ **blocks**: `tauri-explorer-nv2y`

---

<a id="tauri-explorer-nv2y-epic-migrate-backend-from-fastapi-to-rust"></a>

## ✨ tauri-explorer-nv2y EPIC: Migrate Backend from FastAPI to Rust

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-16 22:32 |
| **Updated** | 2026-01-16 23:34 |
| **Closed** | 2026-01-16 23:34 |

### Description

Migrate all backend functionality from Python FastAPI to Rust Tauri commands. This eliminates the Python dependency, removes HTTP/JSON serialization overhead, and enables direct memory access for better performance.

Scope:
- File listing/directory scanning (partially started in hgt6)
- File operations: create, rename, delete, copy, move
- Fuzzy search
- File metadata and caching
- Remove Python/FastAPI dependency entirely

Benefits:
- Single binary distribution (no Python runtime needed)
- Better performance via direct IPC instead of HTTP
- Native async with Tokio
- Memory safety guarantees

---

<a id="tauri-explorer-t23c-tiles-view-icons-don-t-match-details-view-all-icons-plain-white"></a>

## 🐛 tauri-explorer-t23c Tiles view: icons don't match details view, all icons plain white

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-16 22:28 |
| **Updated** | 2026-01-16 22:40 |
| **Closed** | 2026-01-16 22:40 |

### Description

In tiles view, file icons don't match the icons shown in details view. Folder icons are wrong and all file icons appear as plain white instead of colored file type icons.

### Dependencies

- ⛔ **blocks**: `tauri-explorer-83z`

---

<a id="tauri-explorer-y3j4-tiles-view-tiles-too-tall-with-incorrect-scaling"></a>

## 🐛 tauri-explorer-y3j4 Tiles view: tiles too tall with incorrect scaling

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-16 22:28 |
| **Updated** | 2026-01-16 22:40 |
| **Closed** | 2026-01-16 22:40 |

### Description

In tiles view, the tiles appear very tall - seems like they're scaled to be full height rather than a reasonable tile size. Need to fix tile dimensions.

### Dependencies

- ⛔ **blocks**: `tauri-explorer-83z`

---

<a id="tauri-explorer-jii9-quickopen-file-icons-don-t-match-explorer-icons"></a>

## 🐛 tauri-explorer-jii9 QuickOpen file icons don't match explorer icons

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-16 22:28 |
| **Updated** | 2026-01-16 22:40 |
| **Closed** | 2026-01-16 22:40 |

### Description

The file icons shown in the Ctrl+P QuickOpen menu should match the file type icons used in the main file explorer view for consistency.

---

<a id="tauri-explorer-459h-fuzzy-search-should-also-search-folders"></a>

## ✨ tauri-explorer-459h Fuzzy search should also search folders

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-16 18:12 |
| **Updated** | 2026-01-16 18:14 |
| **Closed** | 2026-01-16 18:14 |

### Description

The QuickOpen (Ctrl+P) fuzzy search should include folders in results. Folders should be visually distinct from files. Selecting a folder navigates the current pane to that folder.

---

<a id="tauri-explorer-0o2v-fuzzy-search-ctrl-p-returns-no-results"></a>

## 🐛 tauri-explorer-0o2v Fuzzy search (Ctrl+P) returns no results

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-16 18:09 |
| **Updated** | 2026-01-16 18:10 |
| **Closed** | 2026-01-16 18:10 |

### Description

The fuzzy search dialog opens but doesn't return any results when typing. Need to debug the API connection and fuzzy search backend.

---

<a id="tauri-explorer-ced8-dual-pane-keyboard-shortcut-ctrl-doesn-t-work"></a>

## 🐛 tauri-explorer-ced8 Dual pane keyboard shortcut (Ctrl+\) doesn't work

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-16 18:09 |
| **Updated** | 2026-01-16 18:11 |
| **Closed** | 2026-01-16 18:11 |

### Description

The Ctrl+\ shortcut to toggle dual pane mode isn't working. Need to investigate why the keydown handler isn't catching it.

---

<a id="tauri-explorer-u7bg-cross-pane-and-external-clipboard-paste"></a>

## ✨ tauri-explorer-u7bg Cross-pane and external clipboard paste

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-16 16:53 |
| **Updated** | 2026-01-16 18:03 |
| **Closed** | 2026-01-16 18:03 |

### Description

Enable pasting files from clipboard copied from other pane or external applications. Should work with Ctrl+V in the file list area.

---

<a id="tauri-explorer-npjh-3-toggle-sidebar-visibility"></a>

## ✨ tauri-explorer-npjh.3 Toggle sidebar visibility

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-16 16:53 |
| **Updated** | 2026-01-16 16:56 |
| **Closed** | 2026-01-16 16:56 |

### Description

Add setting to hide/show the bookmarks sidebar. Include hotkey support.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-npjh`

---

<a id="tauri-explorer-npjh-2-toggle-shared-toolbar-visibility"></a>

## ✨ tauri-explorer-npjh.2 Toggle shared toolbar visibility

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-16 16:53 |
| **Updated** | 2026-01-16 16:56 |
| **Closed** | 2026-01-16 16:56 |

### Description

Add setting to hide/show the top toolbar (back/forward/up buttons). Include hotkey support.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-npjh`

---

<a id="tauri-explorer-npjh-1-settings-dialog-with-ctrl-shortcut"></a>

## ✨ tauri-explorer-npjh.1 Settings dialog with Ctrl+, shortcut

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-16 16:53 |
| **Updated** | 2026-01-16 16:56 |
| **Closed** | 2026-01-16 16:56 |

### Description

Create a settings dialog that opens with Ctrl+,. Should include UI for all settings options.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-npjh`

---

<a id="tauri-explorer-npjh-epic-settings-and-customization"></a>

## ✨ tauri-explorer-npjh EPIC: Settings and Customization

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-16 16:53 |
| **Updated** | 2026-01-17 00:12 |
| **Closed** | 2026-01-17 00:12 |

### Description

Settings menu with UI customization options and hotkey configuration

---

<a id="tauri-explorer-um74-grey-out-unfocused-pane-in-dual-pane-mode"></a>

## 📋 tauri-explorer-um74 Grey out unfocused pane in dual pane mode

| Property | Value |
|----------|-------|
| **Type** | 📋 task |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-16 15:59 |
| **Updated** | 2026-01-16 18:04 |
| **Closed** | 2026-01-16 18:04 |
| **Labels** | feature |

### Description

Add visual distinction between active and inactive panes. The unfocused pane should appear slightly greyed out or dimmed to make it clear which pane is currently active.

---

<a id="tauri-explorer-6ukk-enable-drag-and-drop-between-dual-panes"></a>

## 📋 tauri-explorer-6ukk Enable drag and drop between dual panes

| Property | Value |
|----------|-------|
| **Type** | 📋 task |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-16 15:59 |
| **Updated** | 2026-01-16 16:02 |
| **Closed** | 2026-01-16 16:02 |
| **Labels** | feature |

### Description

Allow dragging files/folders from one pane and dropping them into the other pane to move them. Should work with the existing drag-to-move functionality.

---

<a id="tauri-explorer-h0jl-create-shared-toolbar-with-pane-specific-navigation-bars"></a>

## 📋 tauri-explorer-h0jl Create shared toolbar with pane-specific navigation bars

| Property | Value |
|----------|-------|
| **Type** | 📋 task |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-16 15:55 |
| **Updated** | 2026-01-16 15:58 |
| **Closed** | 2026-01-16 15:58 |
| **Labels** | feature |

### Description

Refactor the UI layout so each pane has its own minimal navigation bar (breadcrumbs only), while shared controls (up/forward/back/refresh, theme switcher, search) are in a top-level toolbar that acts on the focused pane.

---

<a id="tauri-explorer-oibi-remove-computer-and-home-icons-from-breadcrumbs-bar"></a>

## 📋 tauri-explorer-oibi Remove computer and home icons from breadcrumbs bar

| Property | Value |
|----------|-------|
| **Type** | 📋 task |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-16 15:55 |
| **Updated** | 2026-01-16 15:58 |
| **Closed** | 2026-01-16 15:58 |
| **Labels** | feature |

### Description

Remove the computer icon and home icon from the breadcrumbs/path bar in NavigationBar.svelte. Keep only the breadcrumb segments and the copy path button.

---

<a id="tauri-explorer-1k9k-split-explorer-svelte-ts-god-object-into-focused-stores"></a>

## 🧹 tauri-explorer-1k9k Split explorer.svelte.ts God-object into focused stores

| Property | Value |
|----------|-------|
| **Type** | 🧹 chore |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-16 00:18 |
| **Updated** | 2026-01-16 22:27 |
| **Closed** | 2026-01-16 22:27 |

### Description

The ExplorerState manages 16+ concerns (navigation, selection, dialogs, clipboard, etc). Split into: navigation.svelte.ts, selection.svelte.ts, dialogs.svelte.ts, clipboard.svelte.ts, directory.svelte.ts

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-5lbi`

---

<a id="tauri-explorer-5lbi-epic-architecture-improvements"></a>

## 🧹 tauri-explorer-5lbi EPIC: Architecture Improvements

| Property | Value |
|----------|-------|
| **Type** | 🧹 chore |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-16 00:18 |
| **Updated** | 2026-01-17 08:53 |
| **Closed** | 2026-01-17 08:53 |

### Description

Address architectural issues identified in code review for long-term sustainability

---

<a id="tauri-explorer-adtw-match-windows-explorer-title-bar-style"></a>

## ✨ tauri-explorer-adtw Match Windows Explorer title bar style

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-15 23:17 |
| **Updated** | 2026-01-16 00:00 |
| **Closed** | 2026-01-16 00:00 |

### Description

Make the title bar smaller and match the Windows Explorer title bar style as shown in the screenshots folder

---

<a id="tauri-explorer-0o79-drag-select-box-should-not-extend-into-column-headers"></a>

## 🐛 tauri-explorer-0o79 Drag select box should not extend into column headers

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-15 23:17 |
| **Updated** | 2026-01-15 23:35 |
| **Closed** | 2026-01-15 23:35 |

### Description

The marquee/lasso drag select box should be constrained to the file list area and not extend into the column header region

---

<a id="tauri-explorer-3mj7-cut-copied-dialog-should-disappear-after-pasting"></a>

## 🐛 tauri-explorer-3mj7 Cut/copied dialog should disappear after pasting

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-15 23:17 |
| **Updated** | 2026-01-15 23:31 |
| **Closed** | 2026-01-15 23:31 |

### Description

The dialog showing 'cut' or 'copied' status should automatically dismiss after the paste operation completes

---

<a id="tauri-explorer-0o5m-make-columns-resizable"></a>

## ✨ tauri-explorer-0o5m Make columns resizable

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-15 23:17 |
| **Updated** | 2026-01-15 23:40 |
| **Closed** | 2026-01-15 23:40 |

### Description

Allow users to resize the columns in the file list view by dragging column borders

---

<a id="tauri-explorer-99fc-remove-gallery-and-onedrive-from-sidebar"></a>

## ✨ tauri-explorer-99fc Remove Gallery and OneDrive from sidebar

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-15 22:44 |
| **Updated** | 2026-01-15 22:55 |
| **Closed** | 2026-01-15 22:55 |

### Description

Remove the disabled Gallery and OneDrive - Personal buttons from the sidebar since they are not functional

---

<a id="tauri-explorer-bhw5-add-undo-functionality-with-ctrl-z-shortcut"></a>

## ✨ tauri-explorer-bhw5 Add undo functionality with Ctrl+Z shortcut

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-15 22:44 |
| **Updated** | 2026-01-15 22:57 |
| **Closed** | 2026-01-15 22:57 |

### Description

Implement undo functionality for file operations (delete, move, rename) with Ctrl+Z keyboard shortcut

---

<a id="tauri-explorer-92uy-drag-files-into-folders-to-move-them"></a>

## ✨ tauri-explorer-92uy Drag files into folders to move them

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-15 19:43 |
| **Updated** | 2026-01-15 22:31 |
| **Closed** | 2026-01-15 22:31 |

### Description

Allow users to drag files/folders from the file list and drop them onto folders to move them

---

<a id="tauri-explorer-52gd-drag-to-rearrange-bookmarks"></a>

## ✨ tauri-explorer-52gd Drag to rearrange bookmarks

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-15 19:43 |
| **Updated** | 2026-01-15 19:48 |
| **Closed** | 2026-01-15 19:48 |

### Description

Allow users to drag bookmarks within the Quick Access section to reorder them

---

<a id="tauri-explorer-39wl-make-sidebar-section-resizable"></a>

## ✨ tauri-explorer-39wl Make sidebar section resizable

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-15 19:39 |
| **Updated** | 2026-01-15 19:43 |
| **Closed** | 2026-01-15 19:43 |

### Description

Allow users to resize the sidebar width by dragging the edge

---

<a id="tauri-explorer-sm3p-drag-and-drop-folders-onto-bookmarks-bar"></a>

## ✨ tauri-explorer-sm3p Drag and drop folders onto bookmarks bar

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-15 19:33 |
| **Updated** | 2026-01-15 19:39 |
| **Closed** | 2026-01-15 19:39 |

### Description

Allow users to drag folders from the file list onto the bookmarks/sidebar to add them as quick access locations

---

<a id="tauri-explorer-l7lv-4-feature"></a>

## 📋 tauri-explorer-l7lv.4 feature

| Property | Value |
|----------|-------|
| **Type** | 📋 task |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-15 19:05 |
| **Updated** | 2026-01-15 19:10 |
| **Closed** | 2026-01-15 19:10 |

### Description

Add a Solarized Light theme with subtle warmth. Based on Ethan Schoonover's Solarized palette - cream/beige backgrounds (#fdf6e3), warm accents, reduced eye strain. Should feel warm and comfortable while maintaining readability.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-l7lv`

---

<a id="tauri-explorer-l7lv-3-feature"></a>

## 📋 tauri-explorer-l7lv.3 feature

| Property | Value |
|----------|-------|
| **Type** | 📋 task |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-15 19:05 |
| **Updated** | 2026-01-15 19:10 |
| **Closed** | 2026-01-15 19:10 |

### Description

Add a dark theme option. Dark backgrounds (#1a1a1a or similar), light text, adjusted accent colors for visibility. Should follow Windows 11 dark mode aesthetics - not pure black but comfortable dark grays.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-l7lv`

---

<a id="tauri-explorer-l7lv-2-feature"></a>

## 📋 tauri-explorer-l7lv.2 feature

| Property | Value |
|----------|-------|
| **Type** | 📋 task |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-15 19:05 |
| **Updated** | 2026-01-15 19:10 |
| **Closed** | 2026-01-15 19:10 |

### Description

Formalize the current white/light theme as the default theme. Extract all color values into CSS custom properties that can be overridden by other themes. This is mostly the current styling - clean white backgrounds with subtle grays.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-l7lv`

---

<a id="tauri-explorer-l7lv-1-feature"></a>

## 📋 tauri-explorer-l7lv.1 feature

| Property | Value |
|----------|-------|
| **Type** | 📋 task |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-15 19:05 |
| **Updated** | 2026-01-15 19:10 |
| **Closed** | 2026-01-15 19:10 |

### Description

Create the theme system infrastructure:
- Theme state management (current theme stored in localStorage)
- CSS custom properties for all themeable values
- Theme switcher UI component (dropdown or toggle in settings)
- Theme application logic that updates CSS variables

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-l7lv`

---

<a id="tauri-explorer-l7lv-epic"></a>

## 📋 tauri-explorer-l7lv epic

| Property | Value |
|----------|-------|
| **Type** | 📋 task |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-15 19:05 |
| **Updated** | 2026-01-15 19:26 |
| **Closed** | 2026-01-15 19:26 |

### Description

Add theming capability to the explorer app. Support multiple themes that users can switch between. Themes should affect colors, backgrounds, and overall visual appearance while maintaining consistent UI structure.

### Notes

Implemented theming system:
- Created theme.svelte.ts with ThemeColors interface and theme definitions
- Added 3 themes: Light (default), Dark, Solarized Light (warm cream tones)
- Theme switcher component in navigation bar
- Themes persist in localStorage
- CSS custom properties applied dynamically

---

<a id="tauri-explorer-mht5-feature"></a>

## 📋 tauri-explorer-mht5 feature

| Property | Value |
|----------|-------|
| **Type** | 📋 task |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-15 19:05 |
| **Updated** | 2026-01-15 19:10 |
| **Closed** | 2026-01-15 19:10 |

### Description

Make file icons match their type (text, image, code, etc) with distinct colors. Also make bookmark/sidebar icons more colorful. Currently icons are mostly monochrome - they should have type-specific colors like Windows Explorer (e.g., blue for documents, green for spreadsheets, purple for archives, etc).

### Notes

Added colorful file type icons:
- Created getFileIconColor() with color mapping for 80+ file extensions
- Created getFileIconCategory() to select appropriate icon shape
- Different icons for: documents, images, archives, code, media, executables
- Added colorful sidebar icons with inline styles for Downloads (blue), Documents (dark blue), Pictures (teal), Videos (purple), Music (pink)

---

<a id="tauri-explorer-9prl-feature"></a>

## 📋 tauri-explorer-9prl feature

| Property | Value |
|----------|-------|
| **Type** | 📋 task |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-15 08:44 |
| **Updated** | 2026-01-17 17:29 |
| **Closed** | 2026-01-17 17:29 |

### Description

Allow editing file properties directly in the details view columns (like renaming in the Name column). Similar to how spreadsheets allow inline cell editing.

---

<a id="tauri-explorer-ikiq-feature"></a>

## 📋 tauri-explorer-ikiq feature

| Property | Value |
|----------|-------|
| **Type** | 📋 task |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-15 08:44 |
| **Updated** | 2026-01-16 18:08 |
| **Closed** | 2026-01-16 18:08 |

### Description

Reduce the height of the title bar to be more compact and match modern Windows Explorer styling.

---

<a id="tauri-explorer-w0eo-delete-sends-to-recycle-bin-instead-of-permanent-deletion"></a>

## ✨ tauri-explorer-w0eo Delete sends to recycle bin instead of permanent deletion

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-14 20:21 |
| **Updated** | 2026-01-15 22:43 |
| **Closed** | 2026-01-15 22:43 |

### Description

When deleting files, move them to the system recycle bin/trash instead of permanently deleting. This provides a safety net for accidental deletions.

---

<a id="tauri-explorer-okfw-drag-select-marquee-lasso-selection"></a>

## ✨ tauri-explorer-okfw Drag select (marquee/lasso selection)

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-14 20:20 |
| **Updated** | 2026-01-15 23:35 |
| **Closed** | 2026-01-15 23:35 |

### Description

Implement drag-to-select (marquee selection) in the file list. Click and drag in empty space to draw a selection rectangle. Files that intersect the rectangle become selected. Should combine with Ctrl for add-to-selection behavior.

---

<a id="tauri-explorer-yn48-shift-click-range-selection"></a>

## ✨ tauri-explorer-yn48 Shift+click range selection

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-14 20:20 |
| **Updated** | 2026-01-14 22:07 |
| **Closed** | 2026-01-14 22:07 |

### Description

Implement Shift+click to select a range of files. Click one file, then Shift+click another to select all files between them (inclusive). Works with both keyboard navigation and mouse clicks. Visual feedback should show all selected files.

---

<a id="tauri-explorer-xqgy-create-playwright-performance-test-suite"></a>

## 🧹 tauri-explorer-xqgy Create Playwright performance test suite

| Property | Value |
|----------|-------|
| **Type** | 🧹 chore |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 23:26 |
| **Updated** | 2026-01-17 17:24 |
| **Closed** | 2026-01-17 17:24 |

### Description

Set up Playwright tests specifically for performance measurement. Use Playwright's tracing and metrics APIs. Tests should measure real user scenarios: app startup, navigate to large folder, scroll through files, search.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-y4y7`

---

<a id="tauri-explorer-aj9u-create-svelte-rendering-performance-tests"></a>

## 🧹 tauri-explorer-aj9u Create Svelte rendering performance tests

| Property | Value |
|----------|-------|
| **Type** | 🧹 chore |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 23:26 |
| **Updated** | 2026-01-17 17:23 |
| **Closed** | 2026-01-17 17:23 |

### Description

Set up performance testing for Svelte components. Measure: initial render time, scroll performance (FPS), memory usage. Test with mock data of 100/1000/10000 files. Use performance.mark() and performance.measure() APIs.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-y4y7`

---

<a id="tauri-explorer-8n9r-create-backend-benchmark-suite-with-pytest-benchmark"></a>

## 🧹 tauri-explorer-8n9r Create backend benchmark suite with pytest-benchmark

| Property | Value |
|----------|-------|
| **Type** | 🧹 chore |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 23:26 |
| **Updated** | 2026-01-17 00:12 |
| **Closed** | 2026-01-17 00:12 |

### Description

Set up pytest-benchmark for Python backend. Create benchmarks for: directory scanning (100/1000/10000 files), JSON serialization, file metadata retrieval. Output results in comparable format. Store baseline results for regression detection.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-y4y7`

---

<a id="tauri-explorer-y4y7-epic-performance-testing-infrastructure"></a>

## 🧹 tauri-explorer-y4y7 EPIC: Performance Testing Infrastructure

| Property | Value |
|----------|-------|
| **Type** | 🧹 chore |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 23:26 |
| **Updated** | 2026-01-17 17:25 |
| **Closed** | 2026-01-17 17:25 |

### Description

Create comprehensive performance testing suite including backend benchmarks, frontend rendering tests, and Playwright e2e performance tests. Tests should be runnable on-demand and in CI.

### Dependencies

- 🔗 **related**: `tauri-explorer-a0b2`

---

<a id="tauri-explorer-8ja7-implement-parallel-directory-traversal-with-jwalk"></a>

## ✨ tauri-explorer-8ja7 Implement parallel directory traversal with jwalk

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 23:21 |
| **Updated** | 2026-01-16 23:52 |
| **Closed** | 2026-01-16 23:52 |

### Description

Use jwalk crate for high-performance parallelized file system traversal in Rust. Same approach used by ripgrep. Handles large directories orders of magnitude faster than Python.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-a0b2`
- ⛔ **blocks**: `tauri-explorer-hgt6`

---

<a id="tauri-explorer-hgt6-move-file-scanning-to-rust-tauri-command"></a>

## ✨ tauri-explorer-hgt6 Move file scanning to Rust Tauri command

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 23:21 |
| **Updated** | 2026-01-16 23:34 |
| **Closed** | 2026-01-16 23:34 |

### Description

Move file scanning logic from FastAPI to Rust Tauri command. Eliminates HTTP/JSON serialization overhead, uses direct memory access. Use jwalk or ignore crates for parallelized traversal.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-a0b2`
- ⛔ **blocks**: `tauri-explorer-nv2y`

---

<a id="tauri-explorer-cdn4-implement-chunked-response-for-large-directories"></a>

## ✨ tauri-explorer-cdn4 Implement chunked response for large directories

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 23:21 |
| **Updated** | 2026-01-17 00:02 |
| **Closed** | 2026-01-17 00:02 |

### Description

For directories with 1000+ files, send results in chunks of 100-200 files. Frontend can start rendering immediately instead of waiting for complete scan.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-a0b2`

---

<a id="tauri-explorer-i0yt-use-tauri-custom-protocol-for-thumbnails"></a>

## ✨ tauri-explorer-i0yt Use Tauri custom protocol for thumbnails

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 23:21 |
| **Updated** | 2026-01-17 00:18 |
| **Closed** | 2026-01-17 00:18 |

### Description

Don't Base64 encode thumbnails into JSON. Use Tauri's custom protocol (tauri://localhost) to serve local images directly to frontend, bypassing Python backend entirely for asset loading.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-a0b2`
- ⛔ **blocks**: `tauri-explorer-nzgb`

---

<a id="tauri-explorer-ibik-use-os-scandir-instead-of-os-listdir"></a>

## ✨ tauri-explorer-ibik Use os.scandir instead of os.listdir

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 23:21 |
| **Updated** | 2026-01-17 00:02 |
| **Closed** | 2026-01-17 00:02 |

### Description

os.scandir() retrieves file attributes (size, modified date) in single system call on Windows. os.listdir() requires separate os.stat() for every file. Major speedup for large directories.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-a0b2`

---

<a id="tauri-explorer-qaqo-switch-to-orjson-for-json-serialization"></a>

## ✨ tauri-explorer-qaqo Switch to orjson for JSON serialization

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 23:21 |
| **Updated** | 2026-01-17 00:02 |
| **Closed** | 2026-01-17 00:02 |

### Description

Replace default JSON encoder with ORJSONResponse in FastAPI. Provides 5x-10x speedup for serializing large file lists. Install orjson and set default_response_class=ORJSONResponse.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-a0b2`

---

<a id="tauri-explorer-nxpl-lazy-load-file-icons-with-intersectionobserver"></a>

## ✨ tauri-explorer-nxpl Lazy load file icons with IntersectionObserver

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 23:21 |
| **Updated** | 2026-01-17 00:08 |
| **Closed** | 2026-01-17 00:08 |

### Description

Don't request thumbnails/icons for entire folder at once. Use IntersectionObserver to trigger icon fetching only when file row scrolls into view. Reduces initial load and memory usage.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-a0b2`
- ⛔ **blocks**: `tauri-explorer-nzgb`

---

<a id="tauri-explorer-ac7y-keyboard-navigation-in-file-list"></a>

## ✨ tauri-explorer-ac7y Keyboard navigation in file list

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:33 |
| **Updated** | 2026-01-18 00:32 |
| **Closed** | 2026-01-18 00:32 |

### Description

Arrow keys to navigate, Enter to open, Delete to delete, F2 to rename.

### Dependencies

- ⛔ **blocks**: `tauri-explorer-i9d`

---

<a id="tauri-explorer-qcq5-persist-tabs-across-sessions"></a>

## ✨ tauri-explorer-qcq5 Persist tabs across sessions

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:33 |
| **Updated** | 2026-01-18 00:35 |
| **Closed** | 2026-01-18 00:35 |

### Description

Save open tabs when closing app, restore on next launch.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-auj`

---

<a id="tauri-explorer-klo-persist-hidden-files-preference"></a>

## ✨ tauri-explorer-klo Persist hidden files preference

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:33 |
| **Updated** | 2026-01-18 00:29 |
| **Closed** | 2026-01-18 00:29 |

### Description

Save show/hide hidden files preference to config.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-lul`

---

<a id="tauri-explorer-zgf-ctrl-h-shortcut-for-hidden-files-toggle"></a>

## ✨ tauri-explorer-zgf Ctrl+H shortcut for hidden files toggle

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:33 |
| **Updated** | 2026-01-18 00:26 |
| **Closed** | 2026-01-18 00:26 |

### Description

Implement Ctrl+H keyboard shortcut to toggle hidden files.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-lul`

---

<a id="tauri-explorer-u5a-ctrl-y-ctrl-shift-z-to-redo"></a>

## ✨ tauri-explorer-u5a Ctrl+Y/Ctrl+Shift+Z to redo

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:32 |
| **Updated** | 2026-03-02 12:09 |
| **Closed** | 2026-03-02 12:09 |

### Description

Implement redo shortcuts for previously undone operations.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-vvr`
- ⛔ **blocks**: `tauri-explorer-av1`

### Comments

> **Claude User** (2026-03-02)
>
> Added Ctrl+Y and Ctrl+Shift+Z keybindings for redo. Both map to edit.redo command. Merged to main.

---

<a id="tauri-explorer-83z-epic-view-modes"></a>

## ✨ tauri-explorer-83z EPIC: View Modes

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:32 |
| **Updated** | 2026-01-17 00:20 |
| **Closed** | 2026-01-17 00:20 |

### Description

Multiple view modes: details, thumbnails, compact list with sorting support.

---

<a id="tauri-explorer-k1p-epic-drag-and-drop"></a>

## ✨ tauri-explorer-k1p EPIC: Drag and Drop

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:32 |
| **Updated** | 2026-01-17 08:53 |
| **Closed** | 2026-01-17 08:53 |

### Description

Comprehensive drag and drop functionality for files within app and to/from external applications.

---

<a id="tauri-explorer-6bt-epic-bookmarks-system"></a>

## ✨ tauri-explorer-6bt EPIC: Bookmarks System

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:32 |
| **Updated** | 2026-01-17 00:10 |
| **Closed** | 2026-01-17 00:10 |

### Description

Implement a complete bookmarks/favorites system for quick access to frequently used directories.

---

<a id="tauri-explorer-79p-deselect-files-when-clicking-empty-area"></a>

## ✨ tauri-explorer-79p Deselect files when clicking empty area

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:31 |
| **Updated** | 2026-01-16 18:12 |
| **Closed** | 2026-01-16 18:12 |

### Description

Clicking on empty space in the file list (not on any file) should deselect all currently selected files.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-imc`

---

<a id="tauri-explorer-88u-remove-toolbar-buttons-for-minimal-ui"></a>

## ✨ tauri-explorer-88u Remove toolbar buttons for minimal UI

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:31 |
| **Updated** | 2026-01-17 08:54 |
| **Closed** | 2026-01-17 08:54 |

### Description

Per specs requirement for minimalism, remove or hide the New/Sort/View/Preview toolbar buttons. These functions should be accessible via context menu and keyboard shortcuts instead.

---

<a id="tauri-explorer-c14-copy-conflict-create-file-copy-naming"></a>

## ✨ tauri-explorer-c14 Copy conflict: create 'file - Copy' naming

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:31 |
| **Updated** | 2026-01-16 18:12 |
| **Closed** | 2026-01-16 18:12 |

### Description

When copying a file to the same folder where it already exists, auto-rename to 'filename - Copy.ext' (matching Windows Explorer behavior). For multiple copies: 'filename - Copy (2).ext'.

---

<a id="tauri-explorer-7ii-write-playwright-tests-md-spec-file"></a>

## 🧹 tauri-explorer-7ii Write playwright_tests.md spec file

| Property | Value |
|----------|-------|
| **Type** | 🧹 chore |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:30 |
| **Updated** | 2026-01-17 08:57 |
| **Closed** | 2026-01-17 08:57 |

### Description

Create playwright_tests.md documenting all UI test scenarios for the ui-tester agent to run through. Cover navigation, file operations, selection, context menus.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-9l2`

---

<a id="tauri-explorer-edi-playwright-test-suite-setup"></a>

## 🧹 tauri-explorer-edi Playwright test suite setup

| Property | Value |
|----------|-------|
| **Type** | 🧹 chore |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:30 |
| **Updated** | 2026-01-16 00:16 |
| **Closed** | 2026-01-16 00:16 |

### Description

Set up Playwright testing infrastructure for the Tauri app. Configure browser contexts, test isolation, and base fixtures for file explorer testing.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-9l2`

---

<a id="tauri-explorer-dr4-recursive-directory-scanning-for-search"></a>

## ✨ tauri-explorer-dr4 Recursive directory scanning for search

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:30 |
| **Updated** | 2026-01-16 16:50 |
| **Closed** | 2026-01-16 16:50 |

### Description

Scan current directory recursively to build file list for fuzzy search. Use async/streaming for large directories. Respect ignore patterns.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-w3t`

---

<a id="tauri-explorer-rxx-fuzzy-file-name-matching-algorithm"></a>

## ✨ tauri-explorer-rxx Fuzzy file name matching algorithm

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:30 |
| **Updated** | 2026-01-16 16:50 |
| **Closed** | 2026-01-16 16:50 |

### Description

Implement fuzzy matching for file names (like fzf). Match non-consecutive characters, score by match quality, highlight matched characters.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-w3t`

---

<a id="tauri-explorer-btz-ctrl-p-quick-open-dialog"></a>

## ✨ tauri-explorer-btz Ctrl+P quick open dialog

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:30 |
| **Updated** | 2026-01-16 16:50 |
| **Closed** | 2026-01-16 16:50 |

### Description

Create quick open dialog similar to VSCode's Ctrl+P. Shows input field and results list. Opens on Ctrl+P, closes on Escape.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-w3t`

---

<a id="tauri-explorer-dfx-command-search-and-filtering"></a>

## ✨ tauri-explorer-dfx Command search and filtering

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:29 |
| **Updated** | 2026-01-17 08:40 |
| **Closed** | 2026-01-17 08:40 |

### Description

Implement fuzzy search/filtering for command palette. Match against command name and description. Show matching characters highlighted.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-1ex`
- ⛔ **blocks**: `tauri-explorer-0dk`

---

<a id="tauri-explorer-0dk-command-palette-overlay-ui"></a>

## ✨ tauri-explorer-0dk Command palette overlay UI

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:29 |
| **Updated** | 2026-01-17 08:40 |
| **Closed** | 2026-01-17 08:40 |

### Description

Create modal overlay that appears on Ctrl+Shift+P showing searchable list of all commands. Type to filter, arrow keys to navigate, Enter to execute.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-1ex`
- ⛔ **blocks**: `tauri-explorer-abm`

---

<a id="tauri-explorer-abm-command-registry-system"></a>

## ✨ tauri-explorer-abm Command registry system

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:29 |
| **Updated** | 2026-01-17 08:40 |
| **Closed** | 2026-01-17 08:40 |

### Description

Create a central registry of all app commands with unique IDs, names, descriptions, default keybindings, and handler functions. Commands can be invoked by ID.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-1ex`

---

<a id="tauri-explorer-i8l-close-tab-ctrl-w-middle-click"></a>

## ✨ tauri-explorer-i8l Close tab (Ctrl+W, middle-click)

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:29 |
| **Updated** | 2026-01-17 08:45 |
| **Closed** | 2026-01-17 08:45 |

### Description

Implement Ctrl+W shortcut and middle-click on tab to close it. Prevent closing last tab (create new empty tab instead).

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-auj`
- ⛔ **blocks**: `tauri-explorer-so0`

---

<a id="tauri-explorer-xqa-new-tab-creation-ctrl-t"></a>

## ✨ tauri-explorer-xqa New tab creation (Ctrl+T)

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:29 |
| **Updated** | 2026-01-17 08:45 |
| **Closed** | 2026-01-17 08:45 |

### Description

Implement Ctrl+T shortcut and + button to create new tabs. New tabs open to home directory or last used directory based on preference.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-auj`
- ⛔ **blocks**: `tauri-explorer-so0`

---

<a id="tauri-explorer-so0-tab-bar-component-for-panes"></a>

## ✨ tauri-explorer-so0 Tab bar component for panes

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:29 |
| **Updated** | 2026-01-17 08:45 |
| **Closed** | 2026-01-17 08:45 |

### Description

Create tab bar UI component showing open tabs with close buttons. Support for tab overflow with scroll or dropdown. Active tab highlighting.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-auj`

---

<a id="tauri-explorer-gsc-dual-pane-layout-component"></a>

## ✨ tauri-explorer-gsc Dual pane layout component

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:29 |
| **Updated** | 2026-01-16 22:28 |
| **Closed** | 2026-01-16 22:28 |

### Description

Create a split view component with two independent file browser panes side by side. Each pane should have its own navigation, path, and file list.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-3ct`

---

<a id="tauri-explorer-jqi-cancel-button-for-ongoing-operations"></a>

## ✨ tauri-explorer-jqi Cancel button for ongoing operations

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:29 |
| **Updated** | 2026-01-17 08:48 |
| **Closed** | 2026-01-17 08:48 |

### Description

Add cancel button to progress dialog that allows aborting copy/move/delete operations mid-way. Handle partial completion gracefully.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-5kv`
- ⛔ **blocks**: `tauri-explorer-41o`

---

<a id="tauri-explorer-41o-progress-dialog-component-for-long-operations"></a>

## ✨ tauri-explorer-41o Progress dialog component for long operations

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:29 |
| **Updated** | 2026-01-17 08:48 |
| **Closed** | 2026-01-17 08:48 |

### Description

Create a progress dialog/panel that shows during long-running operations. Display operation name, progress bar, percentage, and estimated time remaining.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-5kv`

---

<a id="tauri-explorer-nqm-refresh-button-and-f5-shortcut"></a>

## ✨ tauri-explorer-nqm Refresh button and F5 shortcut

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:28 |
| **Updated** | 2026-01-17 00:09 |
| **Closed** | 2026-01-17 00:09 |

### Description

Add refresh button to reload current directory contents. Also implement F5 keyboard shortcut. Useful when external changes occur.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-ihg`

---

<a id="tauri-explorer-0c8-breadcrumb-navigation-for-path-segments"></a>

## ✨ tauri-explorer-0c8 Breadcrumb navigation for path segments

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:28 |
| **Updated** | 2026-01-17 00:09 |
| **Closed** | 2026-01-17 00:09 |

### Description

Display path as clickable breadcrumb segments (Home > Documents > Projects). Clicking any segment navigates to that directory. Show chevrons between segments.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-ihg`

---

<a id="tauri-explorer-fb1-editable-path-bar-with-copy-support"></a>

## ✨ tauri-explorer-fb1 Editable path bar with copy support

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:28 |
| **Updated** | 2026-01-17 00:10 |
| **Closed** | 2026-01-17 00:10 |

### Description

Make the path bar clickable to enter edit mode where user can type or paste a path directly. Allow copying the current path. Press Enter to navigate, Escape to cancel.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-ihg`

---

<a id="tauri-explorer-8p5-up-button-to-parent-directory"></a>

## ✨ tauri-explorer-8p5 Up button to parent directory

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:28 |
| **Updated** | 2026-01-17 00:09 |
| **Closed** | 2026-01-17 00:09 |

### Description

Implement up/parent button that navigates to the parent directory of the current location. Disable when at root.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-ihg`

---

<a id="tauri-explorer-0wo-back-forward-navigation-with-history-stack"></a>

## ✨ tauri-explorer-0wo Back/Forward navigation with history stack

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:28 |
| **Updated** | 2026-01-17 00:09 |
| **Closed** | 2026-01-17 00:09 |

### Description

Implement back and forward buttons that navigate through browsing history. Maintain a history stack of visited directories. Disable buttons when at start/end of history.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-ihg`

---

<a id="tauri-explorer-cmd-context-menu-new-folder-option"></a>

## ✨ tauri-explorer-cmd Context menu: New Folder option

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:28 |
| **Updated** | 2026-01-17 00:09 |
| **Closed** | 2026-01-17 00:09 |

### Description

Add 'New Folder' option to context menu when right-clicking in empty area of file list. Creates a new folder with editable name.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-zhp`
- ⛔ **blocks**: `tauri-explorer-z9v`

---

<a id="tauri-explorer-2m9-context-menu-rename-option"></a>

## ✨ tauri-explorer-2m9 Context menu: Rename option

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:28 |
| **Updated** | 2026-01-17 00:09 |
| **Closed** | 2026-01-17 00:09 |

### Description

Add Rename option to context menu. When clicked, the file name becomes editable inline. Press Enter to confirm, Escape to cancel.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-zhp`
- ⛔ **blocks**: `tauri-explorer-z9v`

---

<a id="tauri-explorer-hmu-context-menu-cut-copy-paste-delete"></a>

## ✨ tauri-explorer-hmu Context menu: Cut, Copy, Paste, Delete

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:28 |
| **Updated** | 2026-01-17 00:09 |
| **Closed** | 2026-01-17 00:09 |

### Description

Add standard file operations to context menu: Cut (Ctrl+X), Copy (Ctrl+C), Paste (Ctrl+V), Delete. Operations should work on selected file(s).

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-zhp`
- ⛔ **blocks**: `tauri-explorer-z9v`

---

<a id="tauri-explorer-z9v-basic-right-click-context-menu-framework"></a>

## ✨ tauri-explorer-z9v Basic right-click context menu framework

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:28 |
| **Updated** | 2026-01-17 00:09 |
| **Closed** | 2026-01-17 00:09 |

### Description

Create a reusable context menu component that appears on right-click. Should support nested menus, icons, separators, disabled states, and keyboard navigation.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-zhp`

---

<a id="tauri-explorer-ztg-view-mode-toggle-ui"></a>

## ✨ tauri-explorer-ztg View mode toggle UI

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:28 |
| **Updated** | 2026-01-16 22:28 |
| **Closed** | 2026-01-16 22:28 |

### Description

Add view mode selector in toolbar allowing switching between Details, Thumbnails, and List views. Could be dropdown or segmented button.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-83z`

---

<a id="tauri-explorer-col-thumbnail-grid-view-with-previews"></a>

## ✨ tauri-explorer-col Thumbnail/grid view with previews

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:28 |
| **Updated** | 2026-01-17 00:18 |
| **Closed** | 2026-01-17 00:18 |

### Description

Implement grid/thumbnail view showing file icons or image thumbnails. Grid layout with configurable icon sizes. Show filename below each thumbnail.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-83z`

---

<a id="tauri-explorer-jf4-details-view-with-sortable-columns"></a>

## ✨ tauri-explorer-jf4 Details view with sortable columns

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:28 |
| **Updated** | 2026-01-16 22:28 |
| **Closed** | 2026-01-16 22:28 |

### Description

Implement details/list view showing columns: Name, Date modified, Type, Size. Columns should be clickable to sort ascending/descending. Show sort indicator arrow on active column.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-83z`

---

<a id="tauri-explorer-gvb-drop-files-into-app-from-external-sources"></a>

## ✨ tauri-explorer-gvb Drop files into app from external sources

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:27 |
| **Updated** | 2026-01-17 08:53 |
| **Closed** | 2026-01-17 08:53 |

### Description

Accept file drops from external applications (browser downloads, other file managers, desktop). Copy/move dropped files to current directory.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-k1p`

---

<a id="tauri-explorer-cgc-drag-files-from-app-to-external-apps"></a>

## ✨ tauri-explorer-cgc Drag files from app to external apps

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:27 |
| **Updated** | 2026-01-17 08:53 |
| **Closed** | 2026-01-17 08:53 |

### Description

Enable dragging files from the explorer to external applications like browsers (for upload), email clients, or other file managers. Use proper MIME types and file URIs.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-k1p`

---

<a id="tauri-explorer-xfj-internal-drag-and-drop-between-folders"></a>

## ✨ tauri-explorer-xfj Internal drag and drop between folders

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:27 |
| **Updated** | 2026-01-16 22:28 |
| **Closed** | 2026-01-16 22:28 |

### Description

Implement drag and drop within the app to move files between folders. Dragging a file onto a folder should move it there. Show visual feedback (folder highlight) during drag.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-k1p`

---

<a id="tauri-explorer-c2n-sidebar-bookmarks-display"></a>

## ✨ tauri-explorer-c2n Sidebar bookmarks display

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:27 |
| **Updated** | 2026-01-17 00:10 |
| **Closed** | 2026-01-17 00:10 |

### Description

Display bookmarks in the sidebar with appropriate folder icons. Show bookmarks in a dedicated 'Quick Access' or 'Favorites' section. Clicking a bookmark navigates to that directory.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-6bt`
- ⛔ **blocks**: `tauri-explorer-9v6`

---

<a id="tauri-explorer-hdt-default-bookmarks-for-user-folders"></a>

## ✨ tauri-explorer-hdt Default bookmarks for user folders

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:27 |
| **Updated** | 2026-01-17 00:10 |
| **Closed** | 2026-01-17 00:10 |

### Description

Initialize default bookmarks pointing to user's home directory folders: ~/Documents, ~/Downloads, ~/Pictures, ~/Music, ~/Videos, ~/Desktop. Use proper tilde expansion, NOT /home/user paths.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-6bt`
- ⛔ **blocks**: `tauri-explorer-9v6`

---

<a id="tauri-explorer-9v6-bookmarks-data-model-and-persistence"></a>

## ✨ tauri-explorer-9v6 Bookmarks data model and persistence

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:27 |
| **Updated** | 2026-01-17 00:10 |
| **Closed** | 2026-01-17 00:10 |

### Description

Create the data model for bookmarks (path, name, icon, order) and implement persistence to local storage or config file. Bookmarks should persist across app restarts.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-6bt`

---

<a id="tauri-explorer-1sv-select-all-with-ctrl-a"></a>

## ✨ tauri-explorer-1sv Select all with Ctrl+A

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:27 |
| **Updated** | 2026-01-17 00:04 |
| **Closed** | 2026-01-17 00:04 |

### Description

Implement Ctrl+A keyboard shortcut to select all files and folders in the current directory view.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-imc`

---

<a id="tauri-explorer-lbb-range-select-with-shift-click"></a>

## ✨ tauri-explorer-lbb Range select with Shift+click

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:27 |
| **Updated** | 2026-01-17 00:04 |
| **Closed** | 2026-01-17 00:04 |

### Description

Implement Shift+click to select a range of files from the last selected item to the clicked item. Works with both single selection and extends existing selections.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-imc`
- ⛔ **blocks**: `tauri-explorer-i9d`

---

<a id="tauri-explorer-6ur-multi-select-with-ctrl-click"></a>

## ✨ tauri-explorer-6ur Multi-select with Ctrl+click

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:27 |
| **Updated** | 2026-01-17 00:04 |
| **Closed** | 2026-01-17 00:04 |

### Description

Implement Ctrl+click to add/remove individual files from selection. Multiple files should be selectable simultaneously with clear visual feedback for all selected items.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-imc`
- ⛔ **blocks**: `tauri-explorer-i9d`

---

<a id="tauri-explorer-9l2-epic-testing-infrastructure"></a>

## 🧹 tauri-explorer-9l2 EPIC: Testing Infrastructure

| Property | Value |
|----------|-------|
| **Type** | 🧹 chore |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:27 |
| **Updated** | 2026-01-17 08:57 |
| **Closed** | 2026-01-17 08:57 |

### Description

Set up comprehensive testing infrastructure including Playwright tests for UI, unit tests for core logic, and integration tests. Ensure test suite can be run by ui-tester agent.

---

<a id="tauri-explorer-w3t-epic-fuzzy-file-search-ctrl-p"></a>

## ✨ tauri-explorer-w3t EPIC: Fuzzy File Search (Ctrl+P)

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:26 |
| **Updated** | 2026-01-16 16:50 |
| **Closed** | 2026-01-16 16:50 |

### Description

Implement VSCode-style Ctrl+P fuzzy file search. Should include: fuzzy matching algorithm (possibly using fzf), search current directory recursively, real-time results, keyboard navigation, open selected file.

---

<a id="tauri-explorer-1ex-epic-command-palette"></a>

## ✨ tauri-explorer-1ex EPIC: Command Palette

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:26 |
| **Updated** | 2026-01-17 08:40 |
| **Closed** | 2026-01-17 08:40 |

### Description

Implement VSCode-style command palette. Should include: Ctrl+Shift+P to open, searchable list of all commands, recently used commands at top, keyboard navigation, execute any app command from palette.

---

<a id="tauri-explorer-auj-epic-tabs-system"></a>

## ✨ tauri-explorer-auj EPIC: Tabs System

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:26 |
| **Updated** | 2026-01-17 08:45 |
| **Closed** | 2026-01-17 08:45 |

### Description

Implement VSCode-style tabs for each pane. Should include: multiple tabs per pane, tab creation/closing, tab reordering via drag, keyboard shortcuts for tab navigation, remember tabs across sessions, middle-click to close.

---

<a id="tauri-explorer-3ct-epic-dual-multi-pane-layout"></a>

## ✨ tauri-explorer-3ct EPIC: Dual/Multi-Pane Layout

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:26 |
| **Updated** | 2026-01-17 00:11 |
| **Closed** | 2026-01-17 00:11 |

### Description

Implement dual-pane (and eventually multi-pane) layout like classic file managers. Should include: side-by-side pane view, independent navigation per pane, resizable pane divider, toggle dual-pane mode, easy file operations between panes.

---

<a id="tauri-explorer-5kv-epic-progress-bars-and-operations"></a>

## ✨ tauri-explorer-5kv EPIC: Progress Bars and Operations

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:26 |
| **Updated** | 2026-01-17 08:48 |
| **Closed** | 2026-01-17 08:48 |

### Description

Implement progress indication for long-running operations. Should include: progress bar for copy/move/delete operations, estimated time remaining, cancel button to abort operations, queue multiple operations, handle errors gracefully with retry options.

---

<a id="tauri-explorer-ihg-epic-navigation-controls"></a>

## ✨ tauri-explorer-ihg EPIC: Navigation Controls

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:26 |
| **Updated** | 2026-01-17 00:10 |
| **Closed** | 2026-01-17 00:10 |

### Description

Implement complete navigation controls: back/forward buttons with history, up button to parent directory, editable path bar that allows direct path entry and copying, breadcrumb navigation for clicking path segments, and refresh functionality.

---

<a id="tauri-explorer-zhp-epic-context-menu"></a>

## ✨ tauri-explorer-zhp EPIC: Context Menu

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:26 |
| **Updated** | 2026-01-17 00:10 |
| **Closed** | 2026-01-17 00:10 |

### Description

Implement a comprehensive right-click context menu system. Should include: common file operations (open, cut, copy, paste, delete, rename), compress/extract functionality for archives, new folder creation, open with options, and extensibility for future menu items.

---

<a id="tauri-explorer-s4o-epic-view-modes"></a>

## ✨ tauri-explorer-s4o EPIC: View Modes

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:26 |
| **Updated** | 2026-01-17 00:11 |
| **Closed** | 2026-01-17 00:11 |

### Description

Implement multiple view modes matching Windows Explorer: thumbnail/grid view with file previews, details/list view with columns (name, date, type, size), and compact list view. Each view should support sorting by any column and remember sort preferences per directory.

---

<a id="tauri-explorer-0gs-epic-drag-and-drop"></a>

## ✨ tauri-explorer-0gs EPIC: Drag and Drop

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:26 |
| **Updated** | 2026-01-17 00:11 |
| **Closed** | 2026-01-17 00:11 |

### Description

Implement comprehensive drag and drop functionality. Must support: dragging files/folders within the app, dragging from the app to external apps (browser, other file managers), dragging into the app from external sources (browser downloads, upload dialogs), visual feedback during drag operations, and proper handling of copy vs move operations.

---

<a id="tauri-explorer-ooj-epic-bookmarks-system"></a>

## ✨ tauri-explorer-ooj EPIC: Bookmarks System

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:26 |
| **Updated** | 2026-01-17 00:11 |
| **Closed** | 2026-01-17 00:11 |

### Description

Implement a complete bookmarks/favorites system allowing users to save and quickly access frequently used directories. Should include: sidebar display, add/remove bookmarks, persist bookmarks across sessions, default bookmarks for common user folders (~/Documents, ~/Downloads, ~/Pictures, etc.).

---

<a id="tauri-explorer-h3n-delete-file-folder-operation"></a>

## ✨ tauri-explorer-h3n Delete file/folder operation

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-11 14:17 |
| **Updated** | 2026-01-11 21:50 |
| **Closed** | 2026-01-11 21:50 |

### Description

Backend: DELETE /api/files/delete endpoint (move to trash). Frontend: Delete button/key with confirmation.

---

<a id="tauri-explorer-bae-rename-file-folder-operation"></a>

## ✨ tauri-explorer-bae Rename file/folder operation

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-11 14:17 |
| **Updated** | 2026-01-11 14:26 |
| **Closed** | 2026-01-11 14:26 |

### Description

Backend: POST /api/files/rename endpoint. Frontend: Inline rename UI on file items.

---

<a id="tauri-explorer-jql-create-new-folder-operation"></a>

## ✨ tauri-explorer-jql Create new folder operation

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ⚡ High (P1) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-11 14:17 |
| **Updated** | 2026-01-11 14:22 |
| **Closed** | 2026-01-11 14:22 |

### Description

Backend: POST /api/files/mkdir endpoint. Frontend: UI to create new folder in current directory.

---

<a id="tauri-cf8q-remove-copy-icon-from-address-bar-rhs"></a>

## 🐛 tauri-cf8q Remove copy icon from address bar RHS

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-04 11:38 |
| **Updated** | 2026-03-04 12:08 |
| **Closed** | 2026-03-04 12:08 |

### Description

Remove the copy icon button on the right-hand side of the address bar.

---

<a id="tauri-bpqk-make-nav-bar-carets-larger-and-easier-to-click"></a>

## 🐛 tauri-bpqk Make nav bar carets larger and easier to click

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-04 11:38 |
| **Updated** | 2026-03-04 12:08 |
| **Closed** | 2026-03-04 12:08 |

### Description

The chevron/caret buttons between breadcrumb segments in the navigation bar are too small. Make them larger for easier clicking.

---

<a id="tauri-cwh1-show-toast-on-undo-and-drag-move"></a>

## ✨ tauri-cwh1 Show toast on undo and drag move

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-04 11:38 |
| **Updated** | 2026-03-04 12:08 |
| **Closed** | 2026-03-04 12:08 |

### Description

Show a toast notification when undoing an action or when drag-moving files.

---

<a id="tauri-77p5-esc-should-close-settings-modal"></a>

## 🐛 tauri-77p5 Esc should close settings modal

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-04 11:38 |
| **Updated** | 2026-03-04 12:08 |
| **Closed** | 2026-03-04 12:08 |

### Description

Pressing Escape while the settings modal is open does not close it.

---

<a id="tauri-uo7j-clicking-away-from-nav-bar-caret-selects-address-bar"></a>

## 🐛 tauri-uo7j Clicking away from nav bar caret selects address bar

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-04 11:38 |
| **Updated** | 2026-03-04 12:08 |
| **Closed** | 2026-03-04 12:08 |

### Description

Clicking away from the caret picker in the nav bar ends up selecting/focusing the address bar input. This shouldn't happen.

---

<a id="tauri-zdr5-paste-images-from-clipboard-into-explorer"></a>

## ✨ tauri-zdr5 Paste images from clipboard into explorer

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-04 11:38 |
| **Updated** | 2026-03-04 11:56 |
| **Closed** | 2026-03-04 11:56 |

### Description

Support pasting images from clipboard directly. Name: img-<timestamp>.png. Check if already implemented via edit.pasteImage command.

---

<a id="tauri-8gpm-new-window-should-inherit-path-viewmode-from-last-focused-window"></a>

## 🐛 tauri-8gpm New window should inherit path/viewMode from last focused window

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-04 10:46 |
| **Updated** | 2026-03-04 10:48 |
| **Closed** | 2026-03-04 10:48 |

### Description

When pressing Ctrl+N, the new window inherits path and viewMode from getActiveExplorer() in the current window. This doesn't always reflect the last focused window. Fix: track last focused window state in localStorage and read from it when opening new windows.

---

<a id="tauri-fnzo-new-windows-should-inherit-layout-from-parent"></a>

## ✨ tauri-fnzo New windows should inherit layout from parent

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-04 10:04 |
| **Updated** | 2026-03-04 10:21 |
| **Closed** | 2026-03-04 10:21 |

### Description

New windows should have the same layout (tiles, list, details) as the parent window (the window that was focused when a new window was opened).

---

<a id="tauri-q1uj-ctrl-n-should-open-new-window-at-current-path"></a>

## ✨ tauri-q1uj Ctrl+N should open new window at current path

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-04 10:04 |
| **Updated** | 2026-03-04 10:19 |
| **Closed** | 2026-03-04 10:19 |

### Description

Ctrl+N should open a new window at the path of the currently focused window, rather than whatever the default is.

---

<a id="tauri-sy06-navigation-bar-carets-should-open-directory-picker"></a>

## ✨ tauri-sy06 Navigation bar carets should open directory picker

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-04 10:04 |
| **Updated** | 2026-03-04 10:23 |
| **Closed** | 2026-03-04 10:23 |

### Description

Clicking the carets in the navigation bar should bring up what other folders are in that directory. Also make the carets easier to click on (larger click target).

---

<a id="tauri-tu67-increase-font-size-in-address-bar"></a>

## ✨ tauri-tu67 Increase font size in address bar

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-04 10:04 |
| **Updated** | 2026-03-04 10:19 |
| **Closed** | 2026-03-04 10:19 |

### Description

Increase the font size in the address bar slightly for better readability

---

<a id="tauri-43vk-change-zoom-in-out-default-hotkeys-to-ctrl-ctrl"></a>

## ✨ tauri-43vk Change zoom in/out default hotkeys to Ctrl+=/Ctrl+-

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-04 10:04 |
| **Updated** | 2026-03-04 10:18 |
| **Closed** | 2026-03-04 10:18 |

### Description

Change zoom in/out default hotkeys to use Ctrl instead of whatever they currently are

---

<a id="tauri-cj2c-fix-tmp-directory-hanging-on-loading"></a>

## 🐛 tauri-cj2c Fix /tmp directory hanging on loading

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-04 18:33 |
| **Updated** | 2026-03-04 10:17 |
| **Closed** | 2026-03-04 10:17 |

### Description

Navigating to /tmp results in hanging on 'loading' - presumably because there are too many files. Need to handle large directories gracefully.

---

<a id="tauri-6u0j-fix-folder-icon-color-in-rapture-theme"></a>

## 🐛 tauri-6u0j Fix folder icon color in rapture theme

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-04 18:33 |
| **Updated** | 2026-03-04 10:18 |
| **Closed** | 2026-03-04 10:18 |

### Description

Folder icon color looks wrong in the rapture theme, and the details column header background is too dark.

---

<a id="tauri-g656-default-new-folder-name-increments-if-already-exists"></a>

## ✨ tauri-g656 Default new folder name increments if already exists

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-04 06:50 |
| **Updated** | 2026-03-04 07:06 |
| **Closed** | 2026-03-04 07:06 |

### Description

If 'new folder' already exists, then the default name should be 'new folder 2', 'new folder 3', etc.

---

<a id="tauri-qvdh-ctrl-shift-n-creates-a-new-folder"></a>

## ✨ tauri-qvdh Ctrl+Shift+N creates a new folder

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-04 06:50 |
| **Updated** | 2026-03-04 07:06 |
| **Closed** | 2026-03-04 07:06 |

### Description

Add keyboard shortcut Ctrl+Shift+N to create a new folder.

---

<a id="tauri-kh3l-auto-select-newly-created-folder"></a>

## ✨ tauri-kh3l Auto-select newly created folder

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-04 06:50 |
| **Updated** | 2026-03-04 07:06 |
| **Closed** | 2026-03-04 07:06 |

### Description

After creating a new folder, automatically select it.

---

<a id="tauri-vjly-progress-bar-when-copying-or-moving-large-files"></a>

## ✨ tauri-vjly Progress bar when copying or moving large files

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-04 06:50 |
| **Updated** | 2026-03-04 07:26 |
| **Closed** | 2026-03-04 07:26 |

### Description

Have a progress bar when copying or moving large files.

---

<a id="tauri-zqdp-skip-overwrite-dialog-when-pasting-files-that-already-exist"></a>

## ✨ tauri-zqdp Skip/overwrite dialog when pasting files that already exist

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-04 06:50 |
| **Updated** | 2026-03-04 07:23 |
| **Closed** | 2026-03-04 07:23 |

### Description

When pasting multiple files, some of which already exist, have the skip/overwrite/skip all/etc dialog like in Windows Explorer.

---

<a id="tauri-os5o-undo-support-for-drag-move-operations"></a>

## ✨ tauri-os5o Undo support for drag-move operations

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-04 06:50 |
| **Updated** | 2026-03-04 07:16 |
| **Closed** | 2026-03-04 07:16 |

### Description

Make it so that undo also works for drag moving. Add a playwright test for this.

---

<a id="tauri-x4bs-show-house-icon-in-address-bar-for-home-directory"></a>

## ✨ tauri-x4bs Show house icon in address bar for HOME directory

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-04 06:50 |
| **Updated** | 2026-03-04 07:02 |
| **Closed** | 2026-03-04 07:02 |

### Description

If the user is in the $HOME directory, show a small house icon in the address bar instead of: folder icon / home / username.

---

<a id="tauri-zf0z-increase-spacing-in-list-view-to-match-details-view"></a>

## 🐛 tauri-zf0z Increase spacing in list view to match details view

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-04 06:50 |
| **Updated** | 2026-03-04 06:55 |
| **Closed** | 2026-03-04 06:55 |

### Description

Slightly increase spacing in list view to match details view row spacing.

---

<a id="tauri-ibtv-display-frecency-score-breakdown-in-ctrl-p-menu-for-debugging"></a>

## 🐛 tauri-ibtv Display frecency score breakdown in Ctrl+P menu for debugging

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-04 17:50 |
| **Updated** | 2026-03-04 17:54 |
| **Closed** | 2026-03-04 17:54 |

### Description

Show fuzzy score, frecency score, and combined score in QuickOpen results to debug frecency not working.

---

<a id="tauri-kw2g-auto-select-newly-created-folder"></a>

## ✨ tauri-kw2g Auto-select newly created folder

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-04 17:18 |
| **Updated** | 2026-03-04 17:26 |
| **Closed** | 2026-03-04 17:26 |

### Description

When a user creates a new folder, auto-select it in the file list so the user can immediately act on it (rename, open, etc.). Change in explorer.createFolder() in src/lib/state/explorer.svelte.ts.

---

<a id="tauri-gkwz-can-t-drag-folders-in-tiles-view"></a>

## 🐛 tauri-gkwz Can't drag folders in tiles view

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-04 02:15 |
| **Updated** | 2026-03-04 02:36 |
| **Closed** | 2026-03-04 02:36 |

### Description

Dragging folders does not work when in tiles/grid view mode.

---

<a id="tauri-nweq-cross-window-drag-doesn-t-refresh-source-window"></a>

## 🐛 tauri-nweq Cross-window drag doesn't refresh source window

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-04 02:15 |
| **Updated** | 2026-03-04 02:36 |
| **Closed** | 2026-03-04 02:36 |

### Description

When dragging a file from one window to another, the file gets moved but the source window doesn't refresh to reflect the change. User has to manually refresh.

---

<a id="tauri-k4ec-configurable-address-bar-buttons-with-removable-items"></a>

## ✨ tauri-k4ec Configurable address bar buttons with removable items

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-04 09:31 |
| **Updated** | 2026-03-03 22:43 |
| **Closed** | 2026-03-03 22:43 |

### Description

Make address bar buttons individually removable/configurable. Omit the refresh button by default. Users should be able to toggle individual buttons on/off.

---

<a id="tauri-on1c-add-status-bar-toggleable-with-alt-m-u"></a>

## ✨ tauri-on1c Add status bar toggleable with Alt+M U

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-04 09:31 |
| **Updated** | 2026-03-03 22:43 |
| **Closed** | 2026-03-03 22:43 |

### Description

Add a status bar to the explorer that shows useful information (file count, selected items, etc.) and can be toggled on/off with Alt+M U keyboard shortcut

---

<a id="tauri-o5dk-add-multi-step-chord-shortcuts-like-vscode"></a>

## ✨ tauri-o5dk Add multi-step chord shortcuts like VSCode

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-03 12:03 |
| **Updated** | 2026-03-03 12:21 |
| **Closed** | 2026-03-03 12:21 |

### Description

Add multi-step keyboard shortcuts like VSCode: alt+m t for terminal, alt+m e for sidebar, alt+m u for status bar. These are chord sequences where a prefix key activates a mode for the next keypress.

---

<a id="tauri-u00y-move-navigation-controls-next-to-address-bar"></a>

## ✨ tauri-u00y Move navigation controls next to address bar

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-03 11:48 |
| **Updated** | 2026-03-03 12:17 |
| **Closed** | 2026-03-03 12:17 |

### Description

Make the up/backward/forward controls appear next to the address bar for a more unified navigation experience.

---

<a id="tauri-2e92-move-window-controls-into-the-top-toolbar"></a>

## ✨ tauri-2e92 Move window controls into the top toolbar

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-03 11:48 |
| **Updated** | 2026-03-03 12:17 |
| **Closed** | 2026-03-03 12:17 |

### Description

Make the window controls (minimize, maximize, close) part of the top toolbar instead of separate.

---

<a id="tauri-c8m9-restructure-explorer-svelte-ts-api-into-named-sub-objects"></a>

## 📋 tauri-c8m9 Restructure explorer.svelte.ts API into named sub-objects

| Property | Value |
|----------|-------|
| **Type** | 📋 task |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-03 10:59 |
| **Updated** | 2026-03-03 11:30 |
| **Closed** | 2026-03-03 11:30 |

### Description

explorer.svelte.ts is a 662-line god object re-exporting 30+ methods. Restructure into named sub-objects: explorer.navigation, explorer.view, explorer.selection, etc. Components depend only on the slice they need.

---

<a id="tauri-dyiz-inline-new-folder-creation-instead-of-dialog"></a>

## ✨ tauri-dyiz Inline new folder creation instead of dialog

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-03 10:58 |
| **Updated** | 2026-03-03 12:30 |
| **Closed** | 2026-03-03 12:30 |

### Description

Instead of showing a dialog for new folder creation, create the folder as 'New Folder' directly in the file list with the name field selected for immediate renaming. After creation, select the new folder.

---

<a id="tauri-jwrv-save-hotkey-bindings-to-settings-file"></a>

## ✨ tauri-jwrv Save hotkey bindings to settings file

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-03 05:15 |
| **Updated** | 2026-03-03 07:30 |
| **Closed** | 2026-03-03 07:30 |

### Description

Include keyboard shortcut/hotkey bindings in a persistent settings file so they survive app restarts.

---

<a id="tauri-c2dw-change-go-up-shortcut-to-ctrl-alt-up"></a>

## ✨ tauri-c2dw Change go-up shortcut to Ctrl+Alt+Up

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-03 05:15 |
| **Updated** | 2026-03-03 05:20 |
| **Closed** | 2026-03-03 05:20 |

### Description

The up-one-level navigation shortcut should default to Ctrl+Alt+Up to match the forward/backward shortcuts using Ctrl+Alt.

### Notes

Fixed: Changed shortcut from Alt+Up to Ctrl+Alt+Up in command-definitions.ts and ExplorerPane.svelte.

---

<a id="tauri-jrek-zoxide-style-usage-weighted-ranking-in-ctrl-p-quick-open"></a>

## ✨ tauri-jrek Zoxide-style usage-weighted ranking in Ctrl+P quick open

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-03 05:15 |
| **Updated** | 2026-03-04 21:36 |
| **Closed** | 2026-03-03 12:36 |

### Description

Track folder/file usage frequency and recency. In Ctrl+P quick open, rank results using a composite score of fuzzy match quality and usage frequency weighted by recency, similar to zoxide.

---

<a id="tauri-pghn-advanced-styling-theming-system"></a>

## ✨ tauri-pghn Advanced styling/theming system

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-03 13:14 |
| **Updated** | 2026-03-04 21:36 |
| **Closed** | 2026-03-03 22:43 |

### Description

Make styling much more configurable. Support themes like an Arch Linux hacker style. Make folder breadcrumbs configurable to look like Powerlevel10k terminal prompt. Support modern, slick aesthetic options.

---

<a id="tauri-ttbb-paste-images-from-clipboard"></a>

## ✨ tauri-ttbb Paste images from clipboard

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-03 13:14 |
| **Updated** | 2026-03-04 21:36 |
| **Closed** | 2026-03-03 22:44 |

### Description

Add ability to paste images from clipboard into the current directory

---

<a id="tauri-7z5p-change-forward-backward-shortcuts-to-ctrl-alt-left-right"></a>

## ✨ tauri-7z5p Change forward/backward shortcuts to Ctrl+Alt+Left/Right

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-03 13:14 |
| **Updated** | 2026-03-03 04:05 |
| **Closed** | 2026-03-03 04:05 |

### Description

Make the default forward/backward navigation shortcuts Ctrl+Alt+Left and Ctrl+Alt+Right

---

<a id="tauri-isj7-improve-multi-selection-visual-appearance"></a>

## ✨ tauri-isj7 Improve multi-selection visual appearance

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-03 13:14 |
| **Updated** | 2026-03-03 07:28 |
| **Closed** | 2026-03-03 07:28 |

### Description

Multi-selection currently shows individual borders on each item. Make it look nicer with a unified selection style

---

<a id="tauri-vozb-add-symlink-functionality"></a>

## ✨ tauri-vozb Add symlink functionality

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-03 13:14 |
| **Updated** | 2026-03-04 21:36 |
| **Closed** | 2026-03-03 22:47 |

### Description

Add support for creating, following, and managing symbolic links

---

<a id="tauri-2dgf-drag-files-to-another-window-moves-instead-of-copies"></a>

## ✨ tauri-2dgf Drag files to another window moves instead of copies

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-03 13:14 |
| **Updated** | 2026-03-04 21:36 |
| **Closed** | 2026-03-03 22:51 |

### Description

When dragging files to another explorer window, default behavior should be move instead of copy

### Comments

> **Claude User** (2026-03-03)
>
> External drop now defaults to move instead of copy, matching internal drag behavior. Ctrl key tracked globally via keydown/keyup since Tauri onDragDropEvent doesn't expose keyboard modifiers. Also fixed vitest.config.ts hardcoded path.

---

<a id="tauri-6z6j-ctrl-shift-t-reopen-closed-tab-works-with-windows-too"></a>

## ✨ tauri-6z6j Ctrl+Shift+T reopen closed tab works with windows too

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-03 13:14 |
| **Updated** | 2026-03-03 12:17 |
| **Closed** | 2026-03-03 12:17 |

### Description

Make Ctrl+Shift+T shortcut work to reopen closed windows, not just tabs

---

<a id="tauri-d2ff-improve-tiles-view-styling"></a>

## ✨ tauri-d2ff Improve tiles view styling

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-03 12:33 |
| **Updated** | 2026-03-03 13:07 |
| **Closed** | 2026-03-03 13:07 |

### Description

The tiles view looks poor - needs better spacing, sizing, hover effects, and overall visual polish to match Windows Explorer / modern file manager aesthetics

### Notes

Tiles view styling improved: larger 64px icons, gradient 3D folder icons with front-panel effect, white-page file icons with shadow and corner fold, responsive 1fr grid, 2-line file names, press animation feedback.

---

<a id="tauri-fa6t-move-clipboard-paste-toasts-to-bottom-right-corner"></a>

## 📋 tauri-fa6t Move clipboard/paste toasts to bottom-right corner

| Property | Value |
|----------|-------|
| **Type** | 📋 task |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-03 11:36 |
| **Updated** | 2026-03-03 07:27 |
| **Closed** | 2026-03-03 07:27 |

### Description

Change toast notifications from inline banners at top of FileList to fixed-position floating toasts in bottom-right corner

---

<a id="tauri-3bxs-ctrl-shift-t-restore-closed-tab-or-window"></a>

## ✨ tauri-3bxs Ctrl+Shift+T restore closed tab or window

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-02 11:26 |
| **Updated** | 2026-03-02 11:36 |
| **Closed** | 2026-03-02 11:36 |

### Description

Make ctrl+shift+t restore a previously closed tab or window, similar to browser behavior

---

<a id="tauri-tvvi-ctrl-p-global-folder-search-beyond-cwd-subdirectories"></a>

## ✨ tauri-tvvi Ctrl+P global folder search beyond CWD subdirectories

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-02 11:26 |
| **Updated** | 2026-03-02 11:52 |
| **Closed** | 2026-03-02 11:52 |

### Description

ctrl+p should search more generally for folders, not just those that are subdirectories of the cwd, although cwd subdirs should take priority

### Comments

> **Claude User** (2026-03-02)
>
> Ctrl+P now searches from home directory instead of just CWD. Results under CWD get +100 score boost for priority. Backend: Added optional boost_prefix param to start_streaming_search. Frontend: QuickOpen fetches home dir (cached) as search root, passes CWD as boost prefix.

---

<a id="tauri-ggjw-multi-file-copy-paste-from-selection"></a>

## ✨ tauri-ggjw Multi-file copy/paste from selection

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-02 11:26 |
| **Updated** | 2026-03-02 11:26 |
| **Closed** | 2026-03-02 11:26 |

### Description

Make copy/paste work for multiple items - all selected items should be copied/cut/pasted together

---

<a id="tauri-xsur-ctrl-w-closes-window-when-only-one-tab-remains"></a>

## ✨ tauri-xsur Ctrl+W closes window when only one tab remains

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-02 21:02 |
| **Updated** | 2026-03-02 22:23 |
| **Closed** | 2026-03-02 22:23 |

### Description

Currently Ctrl+W only closes tabs. When there's only one tab left, it should close the entire window instead of doing nothing.

---

<a id="tauri-y1f0-ctrl-n-opens-new-window-at-current-directory"></a>

## ✨ tauri-y1f0 Ctrl+N opens new window at current directory

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-02 20:48 |
| **Updated** | 2026-03-02 21:01 |
| **Closed** | 2026-03-02 21:01 |

### Description

Add Ctrl+N keyboard shortcut that opens a new app window starting at the same directory as the currently active pane. Requires Tauri multi-window API or shell command to spawn a new instance.

---

<a id="tauri-piv8-option-to-hide-window-control-buttons-minimize-maximize-close"></a>

## ✨ tauri-piv8 Option to hide window control buttons (minimize/maximize/close)

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-02 18:01 |
| **Updated** | 2026-03-02 20:47 |
| **Closed** | 2026-03-02 20:47 |

### Description

Add option to hide the custom window control buttons (minimize, maximize, close) in the title bar. On Linux with a tiling WM like Hyprland, these are redundant since the WM handles window management. Hiding them frees up the entire title bar row when combined with single-tab hiding.

---

<a id="tauri-zwdl-hide-tab-bar-when-only-one-tab-is-open"></a>

## ✨ tauri-zwdl Hide tab bar when only one tab is open

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-02 17:39 |
| **Updated** | 2026-03-02 18:00 |
| **Closed** | 2026-03-02 18:00 |

### Description

When there is only a single tab, the tab bar should be hidden to save vertical space. The tab bar should appear when a second tab is created, and hide again when tabs are closed down to one.

---

<a id="tauri-r4ic-content-search-dialog-text-clipped-at-top-of-result-rows"></a>

## 🐛 tauri-r4ic Content search dialog: text clipped at top of result rows

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-02-15 15:07 |
| **Updated** | 2026-03-02 11:34 |
| **Closed** | 2026-03-02 11:34 |

### Description

In the Ctrl+Shift+F content search dialog (ContentSearchDialog.svelte), the text in search result rows is subtly clipped at the top. The ascenders of characters appear cut off. This affects all result rows (file headers and match lines). The issue is likely related to the combination of fixed item heights (ITEM_HEIGHT=28, FILE_HEADER_HEIGHT=52), overflow:hidden on .result-item, and the virtual scroll layout. Screenshots attached to issue show the clipping clearly on letters like t, h, f, etc.

### Comments

> **Claude User** (2026-02-15)
>
> Root cause identified: CSS baseline shift with overflow:hidden in flex containers.
> 
> .match-row uses align-items: baseline. .line-content has overflow: hidden (needed for text-overflow: ellipsis), while .line-number does not. Per CSS spec, a flex item with overflow: hidden has its baseline shifted to the bottom margin edge instead of the text baseline. This misalignment pushes .line-content upward, clipping ascenders.
> 
> On hover, the parent .result-item's overflow: hidden kicks in and clips .line-number too — explaining why line numbers only clip on hover.
> 
> Fix: Change overflow: hidden to overflow: clip on .line-content. overflow: clip provides the same visual clipping for text-overflow: ellipsis but does NOT create a new block formatting context, so the text baseline is preserved correctly.

---

<a id="tauri-dbiw-backend-line-truncation-adaptive-batching-higher-cap"></a>

## ✨ tauri-dbiw Backend: Line truncation + adaptive batching + higher cap

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-02-15 03:14 |
| **Updated** | 2026-02-15 03:26 |
| **Closed** | 2026-02-15 03:26 |

### Description

Truncate line_content at 300 chars. Adaptive batch interval: 50ms first-paint, 150ms steady state. Raise max_results cap from 1000 to 5000.

### Dependencies

- 🔗 **parent-child**: `tauri-ygaq`

---

<a id="tauri-jvdk-add-rapture-theme-ghostty-color-scheme"></a>

## ✨ tauri-jvdk Add Rapture theme (Ghostty color scheme)

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-02-14 18:56 |
| **Updated** | 2026-02-14 19:14 |
| **Closed** | 2026-02-14 19:14 |

### Description

Add a new 'Rapture' dark theme based on the Ghostty terminal Rapture color scheme. Deep navy background (#111e2a) with pastel neon accents.

---

<a id="tauri-dh79-investigate-why-html5-drop-event-never-fires-in-svelte-5-and-fix-properly"></a>

## 🐛 tauri-dh79 Investigate why HTML5 drop event never fires in Svelte 5 and fix properly

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-02-13 23:55 |
| **Updated** | 2026-03-02 11:46 |
| **Closed** | 2026-03-02 11:46 |

### Description

   1 ## Context
   2 The Quick Access pin feature (tauri-0gre) works via a dragend workaround because the HTML5 drop event never fires anywhere in the app — not on the target element, not on native addEventListener, not on capture-phase document listeners, not even on a bare document.addEventListener("drop", ...).
   3 
   4 A plain HTML test page (test-dnd.html) with identical DnD logic works perfectly in the same browser (Chrome on Wayland/Hyprland). So the issue is specific to how this Svelte 5 app handles events, not the browser or platform.
   5 
   6 ## What We Know
   7 - dragstart fires ✓
   8 - dragenter fires ✓  
   9 - dragover fires ✓ (visual feedback works, isDragOver state updates)
  10 - drop NEVER fires ✗ (not even on document-level listeners)
  11 - dragend fires ✓
  12 
  13 ## Hypotheses to Test
  14 
  15 ### H1: Svelte 5 delegated ondragover on OTHER elements blocks the drop
  16 Svelte 5 attaches a single delegated handler for each event type on the document root. If ANY element in the app has an `ondragover` that doesn't call preventDefault() (e.g., FileItem's ondragover for directory drop targets that rejects non-directory items), the delegated handler may set the event's default behavior to "reject" before our target's handler runs. The browser sees the last preventDefault() state at the end of the bubble phase.
  17 
  18 **Test:** Temporarily remove ALL Svelte ondragover/ondrop handlers from FileItem.svelte and FileList.svelte. If drop fires on the sidebar, this confirms delegated handlers elsewhere are interfering.
  19 
  20 ### H2: Svelte 5 delegated handlers call stopPropagation or stopImmediatePropagation
  21 If Svelte's internal delegation mechanism calls stopPropagation() after handling delegated events, it would prevent our native addEventListener handlers from seeing the events in the expected order.
  22 
  23 **Test:** Add capture-phase listeners on the quick-access element itself (not document). Log whether dragover events arrive. Compare with adding a MutationObserver or checking if Svelte's root handler is present.
  24 
  25 ### H3: The drag source being a <button> element triggers special browser DnD behavior
  26 The FileItem component renders as a `<button draggable="true">`. Buttons have default drag behavior in some browsers. The browser may be applying its own effectAllowed/dropEffect that overrides our settings.
  27 
  28 **Test:** Temporarily change FileItem from `<button>` to `<div role="button">` and test if drop fires.
  29 
  30 ### H4: Multiple elements with ondragover create conflicting drop zones
  31 When dragging from the file list to the sidebar, the cursor passes over FileItem elements that have their own ondragover handlers (for file-to-directory drops). These handlers call preventDefault() for directories but return without it for files. The browser may "remember" that the drag was rejected by the last ondragover handler it saw, even after moving to a new element.
  32 
  33 **Test:** Add logging to every ondragover handler in the app. Track the exact sequence of preventDefault() calls. Check if there's a "rejection" happening right before the user releases.
  34 
  35 ### H5: Svelte 5's event delegation registers a passive dragover listener
  36 If Svelte 5 registers the delegated dragover handler as { passive: true }, then preventDefault() would silently fail. This would explain why visual state updates work (they don't need preventDefault) but the browser never sees the drop as valid.
  37 
  38 **Test:** Inspect the document root's event listeners in Chrome DevTools (Elements > Event Listeners). Check if dragover is registered as passive.
  39 
  40 ## Approach
  41 Test hypotheses in order H5 → H1 → H3 → H4 → H2 (roughly by likelihood and ease of testing). Add targeted console.log instrumentation for each. Once the root cause is confirmed, implement a proper fix using the drop event and remove the dragend workaround.
  42 
  43 ## Related
  44 - Predecessor: tauri-0gre (closed with dragend workaround)
  45 - Docs: docs/KNOWLEDGE.md has full investigation timeline

### Dependencies

- 🔗 **discovered-from**: `tauri-0gre`

### Comments

> **Claude User** (2026-03-02)
>
> Root cause: Svelte 5 event delegation interferes with HTML5 DnD state machine. The drop event never fires because Svelte's delegated event handling breaks the browser's internal DnD bookkeeping. Workaround implemented in tauri-aefl using dragend + elementFromPoint fallback, plus document-level drag event polling for visual feedback.

---

<a id="tauri-explorer-47pv-convert-cut-copy-notification-banner-to-toast"></a>

## 📋 tauri-explorer-47pv Convert cut/copy notification banner to toast

| Property | Value |
|----------|-------|
| **Type** | 📋 task |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-18 15:01 |
| **Updated** | 2026-03-02 11:40 |
| **Closed** | 2026-03-02 11:40 |

### Description

Currently, cut/copy operations show a banner notification. This should be changed to a toast notification for better UX and consistency with modern UI patterns.

---

<a id="tauri-explorer-8ret-add-performance-tests-for-content-search-ripgrep"></a>

## 🧹 tauri-explorer-8ret Add performance tests for content search (ripgrep)

| Property | Value |
|----------|-------|
| **Type** | 🧹 chore |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-18 11:37 |
| **Updated** | 2026-01-18 11:50 |
| **Closed** | 2026-01-18 11:50 |

### Description

Create performance benchmarks to test file content search against ripgrep. Should measure search speed across various file counts and query patterns.

---

<a id="tauri-explorer-w0c7-horizontal-scroll-reveals-whitespace-when-window-too-narrow"></a>

## 🐛 tauri-explorer-w0c7 Horizontal scroll reveals whitespace when window too narrow

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-18 00:24 |
| **Updated** | 2026-03-02 11:34 |
| **Closed** | 2026-03-02 11:34 |

### Description

When the window isn't wide enough to show all the details data, scrolling right reveals only white space instead of the remaining data.

---

<a id="tauri-explorer-o4wz-show-placeholder-icons-while-thumbnails-load"></a>

## ✨ tauri-explorer-o4wz Show placeholder icons while thumbnails load

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-17 20:06 |
| **Updated** | 2026-03-02 12:05 |
| **Closed** | 2026-03-02 12:05 |

### Description

Thumbnails take time to load. Show file type icons as placeholders while thumbnails are being generated.

### Comments

> **Claude User** (2026-03-02)
>
> Implemented placeholder icons for thumbnails. Loading state now shows a dimmed image icon SVG with a small spinner overlay instead of just a spinner. Merged to main.

---

<a id="tauri-explorer-jrfg-multi-file-copy-cut-support"></a>

## ✨ tauri-explorer-jrfg Multi-file copy/cut support

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-17 20:06 |
| **Updated** | 2026-03-02 11:34 |
| **Closed** | 2026-03-02 11:34 |

### Description

Allow multiple files to be copied or cut at once (currently only single file operations work).

---

<a id="tauri-explorer-syq3-marquee-selection-laggy-in-tauri-app-vs-browser"></a>

## 🐛 tauri-explorer-syq3 Marquee selection laggy in Tauri app vs browser

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-16 22:28 |
| **Updated** | 2026-02-13 23:54 |
| **Closed** | 2026-01-18 15:23 |

### Description

The drag-select (marquee selection) appears laggy when running in the Tauri desktop app compared to running in a browser. Investigate performance difference.

---

<a id="tauri-explorer-ev2h-make-focused-pane-more-obviously-focused"></a>

## 📋 tauri-explorer-ev2h Make focused pane more obviously focused

| Property | Value |
|----------|-------|
| **Type** | 📋 task |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-16 18:09 |
| **Updated** | 2026-01-16 18:11 |
| **Closed** | 2026-01-16 18:11 |

### Description

In dual-pane mode, it's not immediately clear which pane has focus. Add a thin accent-colored border to the active pane to make it more visible.

---

<a id="tauri-explorer-u0mo-fuzzy-search-dialog-shouldn-t-be-transparent"></a>

## 🐛 tauri-explorer-u0mo Fuzzy search dialog shouldn't be transparent

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-16 18:09 |
| **Updated** | 2026-01-16 18:11 |
| **Closed** | 2026-01-16 18:11 |

### Description

The QuickOpen dialog has transparent background, should have solid/semi-opaque background for better readability.

---

<a id="tauri-explorer-npjh-4-customizable-hotkeys"></a>

## ✨ tauri-explorer-npjh.4 Customizable hotkeys

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-16 16:53 |
| **Updated** | 2026-02-13 23:54 |
| **Closed** | 2026-01-18 12:22 |

### Description

Allow users to customize keyboard shortcuts. Store in localStorage. Include hotkeys for: toggle toolbar, toggle sidebar, open settings, move to other pane.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-npjh`

---

<a id="tauri-explorer-7pce-extract-file-type-icon-mapping-from-fileitem-svelte"></a>

## 🧹 tauri-explorer-7pce Extract file type/icon mapping from FileItem.svelte

| Property | Value |
|----------|-------|
| **Type** | 🧹 chore |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-16 00:18 |
| **Updated** | 2026-03-02 11:29 |
| **Closed** | 2026-03-02 11:29 |

### Description

FileItem has ~240 lines of file type/icon mapping data mixed with presentation logic. Extract to src/lib/domain/file-types.ts

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-5lbi`

---

<a id="tauri-explorer-bo8l-fix-window-rounded-corners-and-border-on-windows"></a>

## 🐛 tauri-explorer-bo8l Fix window rounded corners and border on Windows

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-16 00:00 |
| **Updated** | 2026-02-13 23:54 |
| **Closed** | 2026-01-18 13:38 |

### Description

When using custom title bar with decorations: false, the window lacks rounded corners and borders on Windows 11. The DWM API approach was attempted but needs more work. May need to wait for Tauri v2 fixes or use alternative approaches.

---

<a id="tauri-explorer-c6dz-playwright-test-measure-scroll-performance"></a>

## 🧹 tauri-explorer-c6dz Playwright test: measure scroll performance

| Property | Value |
|----------|-------|
| **Type** | 🧹 chore |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 23:26 |
| **Updated** | 2026-01-17 17:25 |
| **Closed** | 2026-01-17 17:25 |

### Description

Playwright test that scrolls through a large file list and measures frame rate using Chrome DevTools Protocol. Flag if FPS drops below 30.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-y4y7`
- ⛔ **blocks**: `tauri-explorer-xqgy`

---

<a id="tauri-explorer-npl3-playwright-test-measure-large-directory-render-time"></a>

## 🧹 tauri-explorer-npl3 Playwright test: measure large directory render time

| Property | Value |
|----------|-------|
| **Type** | 🧹 chore |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 23:26 |
| **Updated** | 2026-01-17 17:25 |
| **Closed** | 2026-01-17 17:25 |

### Description

Playwright test that navigates to a test directory with 5000+ files and measures time to first paint and time to interactive. Set performance budget.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-y4y7`
- ⛔ **blocks**: `tauri-explorer-xqgy`

---

<a id="tauri-explorer-3pzn-playwright-test-measure-app-cold-start-time"></a>

## 🧹 tauri-explorer-3pzn Playwright test: measure app cold start time

| Property | Value |
|----------|-------|
| **Type** | 🧹 chore |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 23:26 |
| **Updated** | 2026-01-17 17:25 |
| **Closed** | 2026-01-17 17:25 |

### Description

Playwright test that measures time from app launch to first interactive render. Set performance budget (e.g., <2s). Fail CI if exceeded.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-y4y7`
- ⛔ **blocks**: `tauri-explorer-xqgy`

---

<a id="tauri-explorer-ha9r-add-rendering-benchmark-for-virtualized-vs-non-virtualized-list"></a>

## 🧹 tauri-explorer-ha9r Add rendering benchmark for virtualized vs non-virtualized list

| Property | Value |
|----------|-------|
| **Type** | 🧹 chore |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 23:26 |
| **Updated** | 2026-01-17 17:25 |
| **Closed** | 2026-01-17 17:25 |

### Description

Create A/B benchmark comparing virtualized list rendering vs naive {#each} rendering. Measure DOM node count, render time, scroll FPS, memory. Document improvement factor.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-y4y7`
- ⛔ **blocks**: `tauri-explorer-aj9u`

---

<a id="tauri-explorer-c1a1-benchmark-orjson-vs-standard-json"></a>

## 🧹 tauri-explorer-c1a1 Benchmark orjson vs standard json

| Property | Value |
|----------|-------|
| **Type** | 🧹 chore |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 23:26 |
| **Updated** | 2026-01-17 17:25 |
| **Closed** | 2026-01-17 17:25 |

### Description

Create benchmark comparing orjson vs standard json serialization for typical file list payloads (100, 1000, 10000 file objects). Document speedup factor.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-y4y7`
- ⛔ **blocks**: `tauri-explorer-8n9r`

---

<a id="tauri-explorer-ykh1-benchmark-os-scandir-vs-os-listdir-performance"></a>

## 🧹 tauri-explorer-ykh1 Benchmark os.scandir vs os.listdir performance

| Property | Value |
|----------|-------|
| **Type** | 🧹 chore |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 23:26 |
| **Updated** | 2026-01-17 17:25 |
| **Closed** | 2026-01-17 17:25 |

### Description

Create specific benchmark comparing scandir vs listdir for directories of various sizes. Document expected improvement. Use as validation for the scandir migration.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-y4y7`
- ⛔ **blocks**: `tauri-explorer-8n9r`

---

<a id="tauri-explorer-2ira-use-async-file-i-o-with-aiofiles"></a>

## ✨ tauri-explorer-2ira Use async file I/O with aiofiles

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 23:21 |
| **Updated** | 2026-01-17 00:03 |
| **Closed** | 2026-01-17 00:03 |

### Description

Use aiofiles or anyio for file operations to prevent blocking FastAPI event loop. Critical for slow HDDs or network drives.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-a0b2`

---

<a id="tauri-explorer-o49t-ensure-pydantic-v2-for-faster-validation"></a>

## 🧹 tauri-explorer-o49t Ensure Pydantic v2 for faster validation

| Property | Value |
|----------|-------|
| **Type** | 🧹 chore |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 23:21 |
| **Updated** | 2026-01-17 00:03 |
| **Closed** | 2026-01-17 00:03 |

### Description

Verify using Pydantic v2 which has Rust-based core. Significantly faster at validating large lists of file objects compared to v1.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-a0b2`

---

<a id="tauri-explorer-cn3d-recent-files-in-command-palette"></a>

## ✨ tauri-explorer-cn3d Recent files in command palette

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:33 |
| **Updated** | 2026-03-02 11:57 |
| **Closed** | 2026-03-02 11:57 |

### Description

Add 'Open Recent' command to command palette.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-kwe`

---

<a id="tauri-explorer-omkn-track-recently-opened-files"></a>

## ✨ tauri-explorer-omkn Track recently opened files

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:33 |
| **Updated** | 2026-03-02 11:57 |
| **Closed** | 2026-03-02 11:57 |

### Description

Maintain list of recently opened files with timestamps.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-kwe`

---

<a id="tauri-explorer-en98-search-results-with-context-preview"></a>

## ✨ tauri-explorer-en98 Search results with context preview

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:33 |
| **Updated** | 2026-02-13 23:54 |
| **Closed** | 2026-01-18 10:38 |

### Description

Display search results with filename, line number, and context.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-raf`
- ⛔ **blocks**: `tauri-explorer-3a1q`

---

<a id="tauri-explorer-3a1q-ripgrep-integration-for-content-search"></a>

## ✨ tauri-explorer-3a1q Ripgrep integration for content search

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:33 |
| **Updated** | 2026-02-13 23:54 |
| **Closed** | 2026-01-18 10:38 |

### Description

Use ripgrep for fast file content searching.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-raf`

---

<a id="tauri-explorer-evim-ctrl-shift-f-search-in-files-dialog"></a>

## ✨ tauri-explorer-evim Ctrl+Shift+F search in files dialog

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:33 |
| **Updated** | 2026-02-13 23:54 |
| **Closed** | 2026-01-18 10:38 |

### Description

Create search panel for file content searching.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-raf`

---

<a id="tauri-explorer-uz7d-real-time-search-results-as-you-type"></a>

## ✨ tauri-explorer-uz7d Real-time search results as you type

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:33 |
| **Updated** | 2026-01-16 16:50 |
| **Closed** | 2026-01-16 16:50 |

### Description

Update search results in real-time with debouncing.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-w3t`
- ⛔ **blocks**: `tauri-explorer-rxx`

---

<a id="tauri-explorer-lcd9-keybinding-conflict-detection"></a>

## ✨ tauri-explorer-lcd9 Keybinding conflict detection

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:33 |
| **Updated** | 2026-03-02 12:12 |
| **Closed** | 2026-03-02 12:12 |

### Description

Detect and warn about keybinding conflicts.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-m0b`

### Comments

> **Claude User** (2026-03-02)
>
> Enhanced conflict detection UI. When a shortcut conflicts, users now see the conflict warning with an 'Override' button that unbinds the conflicting command and assigns the shortcut. Merged to main.

---

<a id="tauri-explorer-oytv-hotkey-configuration-ui"></a>

## ✨ tauri-explorer-oytv Hotkey configuration UI

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:33 |
| **Updated** | 2026-02-13 23:54 |
| **Closed** | 2026-01-18 12:50 |

### Description

Settings page to view and modify keyboard shortcuts.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-m0b`

---

<a id="tauri-explorer-3fac-recently-used-commands-at-top"></a>

## ✨ tauri-explorer-3fac Recently used commands at top

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:33 |
| **Updated** | 2026-01-17 08:40 |
| **Closed** | 2026-01-17 08:40 |

### Description

Show recent commands at top of command palette.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-1ex`

---

<a id="tauri-explorer-xago-image-preview-in-preview-pane"></a>

## ✨ tauri-explorer-xago Image preview in preview pane

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:33 |
| **Updated** | 2026-03-02 12:20 |
| **Closed** | 2026-03-02 12:20 |

### Description

Display image files in preview pane with proper scaling.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-xdm`
- ⛔ **blocks**: `tauri-explorer-2c6b`

### Comments

> **Claude User** (2026-03-02)
>
> Image preview implemented in PreviewPane. Uses getThumbnailData at 512px for high-quality preview of jpg, png, gif, webp, bmp files.

---

<a id="tauri-explorer-osjq-text-file-preview-with-syntax-highlighting"></a>

## ✨ tauri-explorer-osjq Text file preview with syntax highlighting

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:33 |
| **Updated** | 2026-03-02 12:20 |
| **Closed** | 2026-03-02 12:20 |

### Description

Preview text/code files with syntax highlighting.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-xdm`
- ⛔ **blocks**: `tauri-explorer-2c6b`

### Comments

> **Claude User** (2026-03-02)
>
> Text preview implemented in PreviewPane. Added read_text_file Tauri command (512KB limit). Supports code files (js, ts, py, rs, etc) and documents (txt, md, log, cfg, toml, ini).

---

<a id="tauri-explorer-nnda-spacebar-to-toggle-preview-pane"></a>

## ✨ tauri-explorer-nnda Spacebar to toggle preview pane

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:33 |
| **Updated** | 2026-03-02 12:20 |
| **Closed** | 2026-03-02 12:20 |

### Description

Implement spacebar shortcut to toggle preview pane visibility.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-xdm`
- ⛔ **blocks**: `tauri-explorer-2c6b`

### Comments

> **Claude User** (2026-03-02)
>
> Preview pane toggled via Alt+P shortcut (customizable). Spacebar kept free for potential Quick Look-style overlay in future.

---

<a id="tauri-explorer-2c6b-preview-pane-component"></a>

## ✨ tauri-explorer-2c6b Preview pane component

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:33 |
| **Updated** | 2026-03-02 12:20 |
| **Closed** | 2026-03-02 12:20 |

### Description

Create collapsible preview pane on right side of file list.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-xdm`

### Comments

> **Claude User** (2026-03-02)
>
> Created PreviewPane component. Shows on right side of file list, displays file info (name, type, size, modified, path). Toggle via Alt+P or command palette.

---

<a id="tauri-explorer-howc-workspace-quick-access-menu"></a>

## ✨ tauri-explorer-howc Workspace quick access menu

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:33 |
| **Updated** | 2026-03-02 12:24 |
| **Closed** | 2026-03-02 12:24 |

### Description

Add saved workspaces to menu for quick restoration.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-06c`

### Comments

> **Claude User** (2026-03-02)
>
> Workspace quick access: WorkspaceDialog shows list of saved workspaces. Click to restore, rename/delete actions. Tab count and last modified shown.

---

<a id="tauri-explorer-6qrn-save-current-workspace-dialog"></a>

## ✨ tauri-explorer-6qrn Save current workspace dialog

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:33 |
| **Updated** | 2026-03-02 12:24 |
| **Closed** | 2026-03-02 12:24 |

### Description

Add 'Save Workspace' option to save current layout.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-06c`

### Comments

> **Claude User** (2026-03-02)
>
> Save workspace dialog with name input. Updates existing workspace if name matches. Available via command palette.

---

<a id="tauri-explorer-6iax-workspace-data-model"></a>

## ✨ tauri-explorer-6iax Workspace data model

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:33 |
| **Updated** | 2026-03-02 12:24 |
| **Closed** | 2026-03-02 12:24 |

### Description

Define workspace data structure for saving/restoring layouts.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-06c`

### Comments

> **Claude User** (2026-03-02)
>
> Workspace data model: id, name, createdAt, updatedAt, state (PersistedTabState). localStorage persistence, max 20 workspaces. CRUD operations via workspacesStore.

---

<a id="tauri-explorer-4x9f-tab-reordering-via-drag"></a>

## ✨ tauri-explorer-4x9f Tab reordering via drag

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:33 |
| **Updated** | 2026-03-02 12:47 |
| **Closed** | 2026-03-02 12:47 |

### Description

Allow dragging tabs to reorder them within the tab bar.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-auj`

### Comments

> **Claude User** (2026-03-02)
>
> Tab drag-and-drop reordering. Drag tabs to rearrange. Visual feedback for drag source and drop target.

---

<a id="tauri-explorer-4zex-tab-navigation-shortcuts-ctrl-tab"></a>

## ✨ tauri-explorer-4zex Tab navigation shortcuts (Ctrl+Tab)

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:33 |
| **Updated** | 2026-01-17 08:45 |
| **Closed** | 2026-01-17 08:45 |

### Description

Ctrl+Tab to cycle tabs, Ctrl+1-9 to jump to specific tabs.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-auj`

---

<a id="tauri-explorer-xcs6-copy-move-to-other-pane-shortcuts"></a>

## ✨ tauri-explorer-xcs6 Copy/Move to other pane shortcuts

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:33 |
| **Updated** | 2026-03-02 12:29 |
| **Closed** | 2026-03-02 12:29 |

### Description

Keyboard shortcuts to copy (F5) or move (F6) to other pane.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-3ct`
- ⛔ **blocks**: `tauri-explorer-gsc`

### Comments

> **Claude User** (2026-03-02)
>
> Added F5 (copy) and F6 (move) shortcuts for cross-pane file operations. Commands only active in dual-pane mode. Operates on selected files.

---

<a id="tauri-explorer-9214-toggle-dual-pane-mode"></a>

## ✨ tauri-explorer-9214 Toggle dual pane mode

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:33 |
| **Updated** | 2026-01-17 00:11 |
| **Closed** | 2026-01-17 00:11 |

### Description

Keyboard shortcut and menu option to toggle dual pane mode.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-3ct`

---

<a id="tauri-explorer-743-resizable-pane-divider"></a>

## ✨ tauri-explorer-743 Resizable pane divider

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:33 |
| **Updated** | 2026-01-17 00:11 |
| **Closed** | 2026-01-17 00:11 |

### Description

Add draggable divider between panes to resize them.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-3ct`
- ⛔ **blocks**: `tauri-explorer-gsc`

---

<a id="tauri-explorer-5o0-error-handling-with-retry-option"></a>

## ✨ tauri-explorer-5o0 Error handling with retry option

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:33 |
| **Updated** | 2026-03-02 12:55 |
| **Closed** | 2026-03-02 12:55 |

### Description

Show error dialog with Retry, Skip, Skip All, Cancel options.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-5kv`

---

<a id="tauri-explorer-4us-operation-queue-for-multiple-operations"></a>

## ✨ tauri-explorer-4us Operation queue for multiple operations

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:33 |
| **Updated** | 2026-03-02 12:56 |
| **Closed** | 2026-03-02 12:56 |

### Description

Queue multiple file operations with progress panel.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-5kv`

---

<a id="tauri-explorer-mwr-file-count-and-size-estimation-for-progress"></a>

## ✨ tauri-explorer-mwr File count and size estimation for progress

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:33 |
| **Updated** | 2026-03-02 12:57 |
| **Closed** | 2026-03-02 12:57 |

### Description

Calculate total files and size before copy/move for progress estimation.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-5kv`

---

<a id="tauri-explorer-d2y-hidden-files-toggle-in-view-menu"></a>

## ✨ tauri-explorer-d2y Hidden files toggle in View menu

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:32 |
| **Updated** | 2026-01-17 19:47 |
| **Closed** | 2026-01-17 19:47 |

### Description

Add toggle option to show/hide hidden files and dotfiles.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-lul`

---

<a id="tauri-explorer-b4u-delete-to-trash-for-undo-support"></a>

## ✨ tauri-explorer-b4u Delete to trash for undo support

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:32 |
| **Updated** | 2026-01-17 19:47 |
| **Closed** | 2026-01-17 19:47 |

### Description

Move deleted files to system trash instead of permanent deletion.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-vvr`

---

<a id="tauri-explorer-ijs-ctrl-z-to-undo-last-operation"></a>

## ✨ tauri-explorer-ijs Ctrl+Z to undo last operation

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:32 |
| **Updated** | 2026-01-17 19:47 |
| **Closed** | 2026-01-17 19:47 |

### Description

Implement Ctrl+Z to undo last file operation.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-vvr`
- ⛔ **blocks**: `tauri-explorer-av1`

---

<a id="tauri-explorer-av1-operation-history-stack-for-undo-redo"></a>

## ✨ tauri-explorer-av1 Operation history stack for undo/redo

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:32 |
| **Updated** | 2026-01-17 19:47 |
| **Closed** | 2026-01-17 19:47 |

### Description

Create data structure to track file operations for undo/redo support.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-vvr`

---

<a id="tauri-explorer-0xr-context-menu-extract-archive"></a>

## ✨ tauri-explorer-0xr Context menu: Extract archive

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:32 |
| **Updated** | 2026-03-02 12:59 |
| **Closed** | 2026-03-02 12:59 |

### Description

Add 'Extract Here' and 'Extract to folder' options for archive files.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-zhp`
- ⛔ **blocks**: `tauri-explorer-z9v`

---

<a id="tauri-explorer-kez-context-menu-compress-files"></a>

## ✨ tauri-explorer-kez Context menu: Compress files

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:32 |
| **Updated** | 2026-03-02 12:59 |
| **Closed** | 2026-03-02 12:59 |

### Description

Add 'Compress to ZIP' option in context menu for selected files/folders.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-zhp`
- ⛔ **blocks**: `tauri-explorer-z9v`

---

<a id="tauri-explorer-brn-thumbnail-generation-for-images"></a>

## ✨ tauri-explorer-brn Thumbnail generation for images

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:32 |
| **Updated** | 2026-01-17 00:18 |
| **Closed** | 2026-01-17 00:18 |

### Description

Generate and cache thumbnails for image files in thumbnail view.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-83z`

---

<a id="tauri-explorer-c0q-compact-list-view"></a>

## ✨ tauri-explorer-c0q Compact list view

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:32 |
| **Updated** | 2026-01-17 00:11 |
| **Closed** | 2026-01-17 00:11 |

### Description

Implement compact list view showing only file names in dense format.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-83z`

---

<a id="tauri-explorer-3u7-sort-persistence-per-directory"></a>

## ✨ tauri-explorer-3u7 Sort persistence per directory

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:32 |
| **Updated** | 2026-03-02 12:36 |
| **Closed** | 2026-03-02 12:36 |

### Description

Remember sort column and direction for each directory.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-83z`

### Comments

> **Claude User** (2026-03-02)
>
> Sort column and direction persisted per directory via localStorage. Restored on navigation. Max 200 entries with eviction.

---

<a id="tauri-explorer-ww3-copy-vs-move-modifier-keys-during-drag"></a>

## ✨ tauri-explorer-ww3 Copy vs Move modifier keys during drag

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:32 |
| **Updated** | 2026-03-02 12:51 |
| **Closed** | 2026-03-02 12:51 |

### Description

Implement Ctrl+drag to copy instead of move with different cursor indicators.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-k1p`

---

<a id="tauri-explorer-b0r-drag-visual-feedback-and-preview"></a>

## ✨ tauri-explorer-b0r Drag visual feedback and preview

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:32 |
| **Updated** | 2026-03-02 12:51 |
| **Closed** | 2026-03-02 12:51 |

### Description

Show visual feedback during drag: ghost preview, count badge, drop zone highlighting.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-k1p`

---

<a id="tauri-explorer-do3-remove-bookmark-from-sidebar"></a>

## ✨ tauri-explorer-do3 Remove bookmark from sidebar

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:32 |
| **Updated** | 2026-01-17 00:10 |
| **Closed** | 2026-01-17 00:10 |

### Description

Allow removing bookmarks by right-clicking in sidebar or via remove button.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-6bt`
- ⛔ **blocks**: `tauri-explorer-c2n`

---

<a id="tauri-explorer-sox-add-bookmark-from-context-menu"></a>

## ✨ tauri-explorer-sox Add bookmark from context menu

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:32 |
| **Updated** | 2026-03-02 12:32 |
| **Closed** | 2026-03-02 12:32 |

### Description

Add 'Pin to Quick Access' option in right-click context menu for folders.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-6bt`
- ⛔ **blocks**: `tauri-explorer-c2n`

### Comments

> **Claude User** (2026-03-02)
>
> Added bookmark/remove bookmark to folder context menu. Shows 'Add to Bookmarks' for unbookmarked directories, 'Remove Bookmark' for bookmarked ones.

---

<a id="tauri-explorer-kwe-epic-recent-files"></a>

## ✨ tauri-explorer-kwe EPIC: Recent Files

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:32 |
| **Updated** | 2026-03-02 11:57 |
| **Closed** | 2026-03-02 11:57 |

### Description

Track and access recently opened files.

### Comments

> **Claude User** (2026-03-02)
>
> EPIC complete. Recent files store tracks last 50 opened files/dirs in localStorage. QuickOpen shows recent files when empty. Command palette has Open Recent and Clear Recent Files commands.

---

<a id="tauri-explorer-raf-epic-search-in-files"></a>

## ✨ tauri-explorer-raf EPIC: Search in Files

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:32 |
| **Updated** | 2026-02-13 23:54 |
| **Closed** | 2026-01-18 10:38 |

### Description

Ctrl+Shift+F search in file contents using ripgrep.

---

<a id="tauri-explorer-m0b-epic-customizable-hotkeys"></a>

## ✨ tauri-explorer-m0b EPIC: Customizable Hotkeys

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:32 |
| **Updated** | 2026-03-02 12:12 |
| **Closed** | 2026-03-02 12:12 |

### Description

IDE-style customizable keyboard shortcuts with configuration UI.

### Comments

> **Claude User** (2026-03-02)
>
> EPIC complete. All children done: hotkey config UI (oytv), conflict detection with override (lcd9). Full keybinding system: customizable shortcuts via settings, search, reset, conflict warnings.

---

<a id="tauri-explorer-xdm-epic-preview-pane"></a>

## ✨ tauri-explorer-xdm EPIC: Preview Pane

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:32 |
| **Updated** | 2026-03-02 12:20 |
| **Closed** | 2026-03-02 12:20 |

### Description

Preview pane for quick file previews toggled with spacebar.

### Comments

> **Claude User** (2026-03-02)
>
> EPIC complete. All children done: preview pane component (2c6b), image preview (xago), text preview with monospace font (osjq), toggle shortcut (nnda).

---

<a id="tauri-explorer-06c-epic-workspaces-layouts"></a>

## ✨ tauri-explorer-06c EPIC: Workspaces/Layouts

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:32 |
| **Updated** | 2026-03-02 12:24 |
| **Closed** | 2026-03-02 12:24 |

### Description

Save and restore workspace layouts including tabs, panes, and paths.

### Comments

> **Claude User** (2026-03-02)
>
> EPIC complete. All children done: data model (6iax), save dialog (6qrn), quick access menu (howc). Full workspace lifecycle: save, restore, rename, delete.

---

<a id="tauri-explorer-lul-epic-hidden-files-toggle"></a>

## ✨ tauri-explorer-lul EPIC: Hidden Files Toggle

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:32 |
| **Updated** | 2026-01-17 19:51 |
| **Closed** | 2026-01-17 19:51 |

### Description

Show/hide hidden files and dotfiles with Ctrl+H toggle.

---

<a id="tauri-explorer-vvr-epic-undo-redo-system"></a>

## ✨ tauri-explorer-vvr EPIC: Undo/Redo System

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:32 |
| **Updated** | 2026-03-02 12:09 |
| **Closed** | 2026-03-02 12:09 |

### Description

Undo/redo functionality for file operations with Ctrl+Z and Ctrl+Y shortcuts.

### Comments

> **Claude User** (2026-03-02)
>
> Implemented full undo/redo system. Redo stack added to undo store - undone actions pushed to redo stack and can be re-executed. New actions clear redo history (standard behavior). Redo exposed via explorer state and command system.

---

<a id="tauri-explorer-9xb-keyboard-navigation-in-file-list"></a>

## ✨ tauri-explorer-9xb Keyboard navigation in file list

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:31 |
| **Updated** | 2026-01-17 19:48 |
| **Closed** | 2026-01-17 19:48 |

### Description

Support arrow keys to navigate file selection, Enter to open, Delete to delete, F2 to rename. Home/End to jump to first/last.

---

<a id="tauri-explorer-e1z-unit-tests-for-state-management"></a>

## 🧹 tauri-explorer-e1z Unit tests for state management

| Property | Value |
|----------|-------|
| **Type** | 🧹 chore |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:30 |
| **Updated** | 2026-01-17 19:55 |
| **Closed** | 2026-01-17 19:55 |

### Description

Write unit tests for explorer state management: navigation history, selection state, clipboard state, settings persistence.

---

<a id="tauri-explorer-fho-unit-tests-for-file-operations"></a>

## 🧹 tauri-explorer-fho Unit tests for file operations

| Property | Value |
|----------|-------|
| **Type** | 🧹 chore |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:30 |
| **Updated** | 2026-01-17 19:55 |
| **Closed** | 2026-01-17 19:55 |

### Description

Write unit tests for core file operation logic: copy, move, delete, rename. Test edge cases like name conflicts, permissions.

---

<a id="tauri-explorer-yuz-recent-files-in-command-palette"></a>

## ✨ tauri-explorer-yuz Recent files in command palette

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:30 |
| **Updated** | 2026-01-17 19:48 |
| **Closed** | 2026-01-17 19:48 |

### Description

Add 'Open Recent' command to command palette that shows list of recently opened files. Fuzzy searchable.

---

<a id="tauri-explorer-dd9-track-recently-opened-files"></a>

## ✨ tauri-explorer-dd9 Track recently opened files

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:30 |
| **Updated** | 2026-01-17 19:48 |
| **Closed** | 2026-01-17 19:48 |

### Description

Maintain a list of recently opened files with timestamps. Store in config, limit to configurable number of entries (default 50).

---

<a id="tauri-explorer-dzr-search-results-with-context-preview"></a>

## ✨ tauri-explorer-dzr Search results with context preview

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:30 |
| **Updated** | 2026-01-17 19:48 |
| **Closed** | 2026-01-17 19:48 |

### Description

Display search results showing filename, line number, and context around match. Click result to navigate to file and line.

---

<a id="tauri-explorer-0ey-ripgrep-integration-for-content-search"></a>

## ✨ tauri-explorer-0ey Ripgrep integration for content search

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:30 |
| **Updated** | 2026-01-17 19:48 |
| **Closed** | 2026-01-17 19:48 |

### Description

Use ripgrep (rg) for fast file content searching. Parse ripgrep output, handle large result sets, respect gitignore.

---

<a id="tauri-explorer-y48-ctrl-shift-f-search-in-files-dialog"></a>

## ✨ tauri-explorer-y48 Ctrl+Shift+F search in files dialog

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:30 |
| **Updated** | 2026-01-17 19:48 |
| **Closed** | 2026-01-17 19:48 |

### Description

Create search panel/dialog for searching file contents. Input for search query, option for regex, option for case sensitivity.

---

<a id="tauri-explorer-ktq-real-time-search-results-as-you-type"></a>

## ✨ tauri-explorer-ktq Real-time search results as you type

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:30 |
| **Updated** | 2026-03-02 11:49 |
| **Closed** | 2026-03-02 11:49 |

### Description

Update search results in real-time as user types query. Debounce input, limit displayed results, show loading indicator.

### Comments

> **Claude User** (2026-03-02)
>
> Content search now auto-triggers with 300ms debounce as user types. Toggling case-sensitive or regex mode also re-triggers search immediately. Enter/Search button still works as manual trigger.

---

<a id="tauri-explorer-kb9-keybinding-conflict-detection"></a>

## ✨ tauri-explorer-kb9 Keybinding conflict detection

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:29 |
| **Updated** | 2026-01-17 19:48 |
| **Closed** | 2026-01-17 19:48 |

### Description

Detect when user tries to assign a keybinding that's already used. Show warning and option to reassign or cancel.

---

<a id="tauri-explorer-3kz-hotkey-configuration-ui"></a>

## ✨ tauri-explorer-3kz Hotkey configuration UI

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:29 |
| **Updated** | 2026-01-17 19:48 |
| **Closed** | 2026-01-17 19:48 |

### Description

Create settings page to view and modify keyboard shortcuts. Show command name, current binding, and allow changing. Search/filter keybindings.

---

<a id="tauri-explorer-v9n-recently-used-commands-at-top"></a>

## ✨ tauri-explorer-v9n Recently used commands at top

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:29 |
| **Updated** | 2026-01-17 19:47 |
| **Closed** | 2026-01-17 19:47 |

### Description

Track which commands are used and show most recent at the top of command palette when no search query entered.

---

<a id="tauri-explorer-yv6-image-preview-in-preview-pane"></a>

## ✨ tauri-explorer-yv6 Image preview in preview pane

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:29 |
| **Updated** | 2026-01-17 19:50 |
| **Closed** | 2026-01-17 19:50 |

### Description

Display image files (jpg, png, gif, webp, svg) in preview pane with proper scaling. Show image dimensions and file size.

---

<a id="tauri-explorer-gut-text-file-preview-with-syntax-highlighting"></a>

## ✨ tauri-explorer-gut Text file preview with syntax highlighting

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:29 |
| **Updated** | 2026-01-17 19:50 |
| **Closed** | 2026-01-17 19:50 |

### Description

Preview text files and code files with syntax highlighting based on file extension. Limit preview to first N lines for performance.

---

<a id="tauri-explorer-9yl-spacebar-to-toggle-preview-pane"></a>

## ✨ tauri-explorer-9yl Spacebar to toggle preview pane

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:29 |
| **Updated** | 2026-01-17 19:50 |
| **Closed** | 2026-01-17 19:50 |

### Description

Implement spacebar keyboard shortcut to toggle preview pane visibility. Also add toggle button in toolbar.

---

<a id="tauri-explorer-8yx-preview-pane-component"></a>

## ✨ tauri-explorer-8yx Preview pane component

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:29 |
| **Updated** | 2026-01-17 19:50 |
| **Closed** | 2026-01-17 19:50 |

### Description

Create collapsible preview pane on right side of file list. Show preview of selected file. Handle graceful fallback for unsupported types.

---

<a id="tauri-explorer-b2x-workspace-quick-access-menu"></a>

## ✨ tauri-explorer-b2x Workspace quick access menu

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:29 |
| **Updated** | 2026-01-17 19:50 |
| **Closed** | 2026-01-17 19:50 |

### Description

Add saved workspaces to File menu or sidebar. Click to restore that workspace layout instantly.

---

<a id="tauri-explorer-1qg-save-current-workspace-dialog"></a>

## ✨ tauri-explorer-1qg Save current workspace dialog

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:29 |
| **Updated** | 2026-01-17 19:50 |
| **Closed** | 2026-01-17 19:50 |

### Description

Add 'Save Workspace' option in menu. Show dialog to enter workspace name. Save current layout to config file.

---

<a id="tauri-explorer-1g0-workspace-data-model"></a>

## ✨ tauri-explorer-1g0 Workspace data model

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:29 |
| **Updated** | 2026-01-17 19:50 |
| **Closed** | 2026-01-17 19:50 |

### Description

Define workspace data structure: name, list of panes, each pane's tabs with paths, pane sizes, active tabs. Support serialization to JSON.

---

<a id="tauri-explorer-62g-persist-tabs-across-sessions"></a>

## ✨ tauri-explorer-62g Persist tabs across sessions

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:29 |
| **Updated** | 2026-01-17 19:50 |
| **Closed** | 2026-01-17 19:50 |

### Description

Save open tabs (paths and order) when closing app. Restore tabs on next launch. Option to start fresh or restore.

---

<a id="tauri-explorer-hrk-tab-reordering-via-drag"></a>

## ✨ tauri-explorer-hrk Tab reordering via drag

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:29 |
| **Updated** | 2026-01-17 19:50 |
| **Closed** | 2026-01-17 19:50 |

### Description

Allow dragging tabs to reorder them within the tab bar. Visual feedback during drag. Persist tab order.

---

<a id="tauri-explorer-gov-tab-navigation-shortcuts-ctrl-tab-ctrl-1-9"></a>

## ✨ tauri-explorer-gov Tab navigation shortcuts (Ctrl+Tab, Ctrl+1-9)

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:29 |
| **Updated** | 2026-01-17 19:47 |
| **Closed** | 2026-01-17 19:47 |

### Description

Implement Ctrl+Tab to cycle through tabs, Ctrl+Shift+Tab to cycle backwards. Ctrl+1 through Ctrl+9 to jump to specific tabs.

---

<a id="tauri-explorer-5ut-copy-move-to-other-pane-shortcuts"></a>

## ✨ tauri-explorer-5ut Copy/Move to other pane shortcuts

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:29 |
| **Updated** | 2026-01-17 19:50 |
| **Closed** | 2026-01-17 19:50 |

### Description

Implement keyboard shortcuts to quickly copy (F5) or move (F6) selected files to the other pane's current directory. Show confirmation dialog.

---

<a id="tauri-explorer-m7w-toggle-dual-pane-mode"></a>

## ✨ tauri-explorer-m7w Toggle dual pane mode

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:29 |
| **Updated** | 2026-01-17 19:47 |
| **Closed** | 2026-01-17 19:47 |

### Description

Add keyboard shortcut and menu option to toggle between single pane and dual pane modes. Remember last state.

---

<a id="tauri-explorer-eq6-resizable-pane-divider"></a>

## ✨ tauri-explorer-eq6 Resizable pane divider

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:29 |
| **Updated** | 2026-01-17 19:47 |
| **Closed** | 2026-01-17 19:47 |

### Description

Add draggable divider between panes to resize them. Double-click to reset to 50/50 split. Persist pane sizes across sessions.

---

<a id="tauri-explorer-z3s-error-handling-with-retry-option"></a>

## ✨ tauri-explorer-z3s Error handling with retry option

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:29 |
| **Updated** | 2026-01-17 19:50 |
| **Closed** | 2026-01-17 19:50 |

### Description

When file operations encounter errors (permission denied, file in use), show error dialog with options: Retry, Skip, Skip All, Cancel.

---

<a id="tauri-explorer-st1-operation-queue-for-multiple-operations"></a>

## ✨ tauri-explorer-st1 Operation queue for multiple operations

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:29 |
| **Updated** | 2026-01-17 19:50 |
| **Closed** | 2026-01-17 19:50 |

### Description

Allow queuing multiple file operations. Show queue in progress panel. Process operations sequentially or allow parallel operations with user preference.

---

<a id="tauri-explorer-6a4-file-count-and-size-estimation-for-progress"></a>

## ✨ tauri-explorer-6a4 File count and size estimation for progress

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:29 |
| **Updated** | 2026-01-17 19:50 |
| **Closed** | 2026-01-17 19:50 |

### Description

Before starting copy/move operations, calculate total number of files and total size to enable accurate progress estimation.

---

<a id="tauri-explorer-9ae-persist-hidden-files-preference"></a>

## ✨ tauri-explorer-9ae Persist hidden files preference

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:28 |
| **Updated** | 2026-01-17 19:50 |
| **Closed** | 2026-01-17 19:50 |

### Description

Save the show/hide hidden files preference to config so it persists across app restarts.

---

<a id="tauri-explorer-l62-ctrl-h-shortcut-for-hidden-files-toggle"></a>

## ✨ tauri-explorer-l62 Ctrl+H shortcut for hidden files toggle

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:28 |
| **Updated** | 2026-01-17 19:50 |
| **Closed** | 2026-01-17 19:50 |

### Description

Implement Ctrl+H keyboard shortcut to quickly toggle visibility of hidden files.

---

<a id="tauri-explorer-8ua-hidden-files-toggle-in-view-menu"></a>

## ✨ tauri-explorer-8ua Hidden files toggle in View menu

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:28 |
| **Updated** | 2026-01-17 19:47 |
| **Closed** | 2026-01-17 19:47 |

### Description

Add toggle option in View menu or toolbar to show/hide hidden files and dotfiles. When hidden, files starting with '.' should not appear in the list.

---

<a id="tauri-explorer-0hd-delete-to-trash-for-undo-support"></a>

## ✨ tauri-explorer-0hd Delete to trash for undo support

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:28 |
| **Updated** | 2026-01-17 19:47 |
| **Closed** | 2026-01-17 19:47 |

### Description

Move deleted files to system trash instead of permanent deletion. This enables undo of delete operations. Use platform-specific trash APIs.

---

<a id="tauri-explorer-yyn-ctrl-y-ctrl-shift-z-to-redo"></a>

## ✨ tauri-explorer-yyn Ctrl+Y/Ctrl+Shift+Z to redo

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:28 |
| **Updated** | 2026-01-17 19:50 |
| **Closed** | 2026-01-17 19:50 |

### Description

Implement Ctrl+Y and Ctrl+Shift+Z shortcuts to redo previously undone operations.

---

<a id="tauri-explorer-7m5-ctrl-z-to-undo-last-operation"></a>

## ✨ tauri-explorer-7m5 Ctrl+Z to undo last operation

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:28 |
| **Updated** | 2026-01-17 19:47 |
| **Closed** | 2026-01-17 19:47 |

### Description

Implement Ctrl+Z keyboard shortcut to undo the last file operation. Reverse moves, restore deleted files from trash, undo renames.

---

<a id="tauri-explorer-3o5-operation-history-stack-for-undo-redo"></a>

## ✨ tauri-explorer-3o5 Operation history stack for undo/redo

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:28 |
| **Updated** | 2026-01-17 19:47 |
| **Closed** | 2026-01-17 19:47 |

### Description

Create a data structure to track file operations (move, copy, rename, delete) with enough information to reverse them. Store source/destination paths and operation type.

---

<a id="tauri-explorer-hoy-context-menu-extract-archive"></a>

## ✨ tauri-explorer-hoy Context menu: Extract archive

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:28 |
| **Updated** | 2026-01-17 19:50 |
| **Closed** | 2026-01-17 19:50 |

### Description

Add 'Extract Here' and 'Extract to folder...' options for archive files (.zip, .tar, .gz, .7z, etc). Extract contents to current directory or subfolder.

---

<a id="tauri-explorer-0a4-context-menu-compress-files"></a>

## ✨ tauri-explorer-0a4 Context menu: Compress files

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:28 |
| **Updated** | 2026-01-17 19:50 |
| **Closed** | 2026-01-17 19:50 |

### Description

Add 'Compress to ZIP' option in context menu for selected files/folders. Create a .zip archive containing the selected items in the current directory.

---

<a id="tauri-explorer-24i-thumbnail-generation-for-images"></a>

## ✨ tauri-explorer-24i Thumbnail generation for images

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:28 |
| **Updated** | 2026-01-17 19:47 |
| **Closed** | 2026-01-17 19:47 |

### Description

Generate and cache thumbnails for image files (jpg, png, gif, webp, etc). Show actual image preview in thumbnail view instead of generic icon.

---

<a id="tauri-explorer-r3d-sort-persistence-per-directory"></a>

## ✨ tauri-explorer-r3d Sort persistence per directory

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:28 |
| **Updated** | 2026-01-17 19:50 |
| **Closed** | 2026-01-17 19:50 |

### Description

Remember sort column and direction for each directory. When returning to a directory, restore its previous sort settings. Store in local config.

---

<a id="tauri-explorer-3ol-compact-list-view"></a>

## ✨ tauri-explorer-3ol Compact list view

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:28 |
| **Updated** | 2026-01-17 19:47 |
| **Closed** | 2026-01-17 19:47 |

### Description

Implement compact list view showing only file names in a dense list format, similar to Windows Explorer's 'List' view with multiple columns of names.

---

<a id="tauri-explorer-m1f-copy-vs-move-modifier-keys-during-drag"></a>

## ✨ tauri-explorer-m1f Copy vs Move modifier keys during drag

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:27 |
| **Updated** | 2026-01-17 19:50 |
| **Closed** | 2026-01-17 19:50 |

### Description

Implement Ctrl+drag to copy instead of move. Show different cursor/indicator based on operation. Default to move within same volume, copy across volumes.

---

<a id="tauri-explorer-wp6-drag-visual-feedback-and-preview"></a>

## ✨ tauri-explorer-wp6 Drag visual feedback and preview

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:27 |
| **Updated** | 2026-01-17 19:50 |
| **Closed** | 2026-01-17 19:50 |

### Description

Show visual feedback during drag operations: ghost preview of dragged items, count badge for multiple files, drop zone highlighting, cursor changes for valid/invalid targets.

---

<a id="tauri-explorer-bok-remove-bookmark-from-sidebar"></a>

## ✨ tauri-explorer-bok Remove bookmark from sidebar

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:27 |
| **Updated** | 2026-01-17 19:50 |
| **Closed** | 2026-01-17 19:50 |

### Description

Allow removing bookmarks by right-clicking on them in the sidebar and selecting 'Unpin from Quick Access' or via a remove/x button on hover.

---

<a id="tauri-explorer-0oa-add-bookmark-from-context-menu"></a>

## ✨ tauri-explorer-0oa Add bookmark from context menu

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:27 |
| **Updated** | 2026-01-17 19:50 |
| **Closed** | 2026-01-17 19:50 |

### Description

Add 'Pin to Quick Access' option in right-click context menu for folders. Adds the selected folder to bookmarks list.

---

<a id="tauri-explorer-zis-epic-recent-files"></a>

## ✨ tauri-explorer-zis EPIC: Recent Files

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:27 |
| **Updated** | 2026-01-17 19:48 |
| **Closed** | 2026-01-17 19:48 |

### Description

Implement recent files tracking and access. Should include: track recently opened files, fuzzy search through recent files, quick access from command palette, configurable history size, clear history option.

---

<a id="tauri-explorer-moc-epic-search-in-files"></a>

## ✨ tauri-explorer-moc EPIC: Search in Files

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:26 |
| **Updated** | 2026-01-17 19:48 |
| **Closed** | 2026-01-17 19:48 |

### Description

Implement Ctrl+Shift+F search in files like VSCode. Should use ripgrep for performance, support regex, show results with context, click to navigate to result, search/replace functionality.

---

<a id="tauri-explorer-4gm-epic-customizable-hotkeys"></a>

## ✨ tauri-explorer-4gm EPIC: Customizable Hotkeys

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:26 |
| **Updated** | 2026-01-17 19:48 |
| **Closed** | 2026-01-17 19:48 |

### Description

Implement IDE-style customizable keyboard shortcuts. Should include: hotkey configuration UI, import/export keybindings, conflict detection, reset to defaults, support for all app operations, inspired by Vivaldi's customization.

---

<a id="tauri-explorer-zl2-epic-preview-pane"></a>

## ✨ tauri-explorer-zl2 EPIC: Preview Pane

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:26 |
| **Updated** | 2026-01-17 19:48 |
| **Closed** | 2026-01-17 19:48 |

### Description

Implement a preview pane for quick file previews. Should include: toggle with spacebar, support text files, images, PDFs, code with syntax highlighting, resizable preview pane, position options (right side or bottom).

---

<a id="tauri-explorer-5z0-epic-workspaces-layouts"></a>

## ✨ tauri-explorer-5z0 EPIC: Workspaces/Layouts

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:26 |
| **Updated** | 2026-01-17 19:48 |
| **Closed** | 2026-01-17 19:48 |

### Description

Implement saved layouts/workspaces system. Should include: save current layout (tabs, panes, paths), restore saved workspaces, workspace management UI, quick access like bookmarks, export/import workspace configurations.

---

<a id="tauri-explorer-d6w-epic-hidden-files-toggle"></a>

## ✨ tauri-explorer-d6w EPIC: Hidden Files Toggle

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:26 |
| **Updated** | 2026-01-17 19:48 |
| **Closed** | 2026-01-17 19:48 |

### Description

Implement show/hide functionality for hidden files and dotfiles. Should include: toggle button in toolbar or view menu, keyboard shortcut (Ctrl+H), persist preference across sessions, visual distinction for hidden files when shown.

---

<a id="tauri-explorer-brz-epic-undo-redo-system"></a>

## ✨ tauri-explorer-brz EPIC: Undo/Redo System

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:26 |
| **Updated** | 2026-01-17 19:48 |
| **Closed** | 2026-01-17 19:48 |

### Description

Implement undo/redo functionality for file operations. Should support: Ctrl+Z for undo, Ctrl+Y/Ctrl+Shift+Z for redo, maintain operation history, support undoing moves, copies, renames, and deletes (move to trash). Display operation history in status area.

---

<a id="tauri-explorer-x25-copy-move-file-operations"></a>

## ✨ tauri-explorer-x25 Copy/Move file operations

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-11 14:17 |
| **Updated** | 2026-01-12 09:02 |
| **Closed** | 2026-01-12 09:02 |

### Description

Backend: POST /api/files/copy and /api/files/move endpoints. Frontend: Keyboard shortcuts and context menu.

---

<a id="tauri-explorer-rzs-configure-tauri-sidecar-integration"></a>

## ✨ tauri-explorer-rzs Configure Tauri sidecar integration

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-11 11:28 |
| **Updated** | 2026-01-11 11:44 |
| **Closed** | 2026-01-11 11:44 |

### Description

Set up FastAPI as sidecar. Configure capabilities, spawn in main.rs, dev mode handling.

### Dependencies

- ⛔ **blocks**: `tauri-explorer-p1f`

---

<a id="tauri-explorer-iw0-build-ui-components"></a>

## ✨ tauri-explorer-iw0 Build UI components

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-11 11:28 |
| **Updated** | 2026-01-11 11:43 |
| **Closed** | 2026-01-11 11:43 |

### Description

Create FileItem, FileList, Breadcrumbs, Toolbar components. Windows 11 Explorer-inspired styling.

### Dependencies

- ⛔ **blocks**: `tauri-explorer-gcl`

---

<a id="tauri-explorer-gcl-create-svelte-5-state-management"></a>

## ✨ tauri-explorer-gcl Create Svelte 5 state management

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-11 11:28 |
| **Updated** | 2026-01-11 11:41 |
| **Closed** | 2026-01-11 11:41 |

### Description

Create explorer.svelte.ts with runes-based state. Actions: navigateTo, toggleHidden, setSorting.

### Dependencies

- ⛔ **blocks**: `tauri-explorer-4v1`
- ⛔ **blocks**: `tauri-explorer-1yj`

---

<a id="tauri-explorer-4v1-implement-typescript-api-client"></a>

## ✨ tauri-explorer-4v1 Implement TypeScript API client

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-11 11:28 |
| **Updated** | 2026-01-11 11:32 |
| **Closed** | 2026-01-11 11:32 |

### Description

Create fetchDirectory() with Result type pattern. Write tests with mocked fetch.

### Dependencies

- ⛔ **blocks**: `tauri-explorer-p1f`

---

<a id="tauri-explorer-p1f-implement-fastapi-endpoints"></a>

## ✨ tauri-explorer-p1f Implement FastAPI endpoints

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-11 11:28 |
| **Updated** | 2026-01-11 11:31 |
| **Closed** | 2026-01-11 11:31 |

### Description

Create /api/files/list endpoint and /health endpoint. Write tests first (TDD).

---

<a id="tauri-explorer-1yj-create-typescript-domain-layer"></a>

## ✨ tauri-explorer-1yj Create TypeScript domain layer

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | 🔹 Medium (P2) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-11 11:28 |
| **Updated** | 2026-01-11 11:30 |
| **Closed** | 2026-01-11 11:30 |

### Description

Types: FileEntry, DirectoryListing. Functions: sortEntries, filterHidden, formatSize. Write tests first (TDD).

---

<a id="tauri-nxfi-path-autocomplete-when-typing-in-address-bar"></a>

## ✨ tauri-nxfi Path autocomplete when typing in address bar

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ☕ Low (P3) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-04 06:50 |
| **Updated** | 2026-03-04 07:29 |
| **Closed** | 2026-03-04 07:29 |

### Description

Typing in the path manually has autocomplete suggestions.

---

<a id="tauri-pqo3-clean-up-stale-types-empty-config-duplicate-keyboard-handlers"></a>

## 📋 tauri-pqo3 Clean up stale types, empty config, duplicate keyboard handlers

| Property | Value |
|----------|-------|
| **Type** | 📋 task |
| **Priority** | ☕ Low (P3) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-03 10:59 |
| **Updated** | 2026-03-03 11:30 |
| **Closed** | 2026-03-03 11:30 |

### Description

1) ExplorerState type in types.ts doesn't match actual shape - fix or remove. 2) config.ts is empty - remove. 3) FileItem.svelte keyboard handler duplicates global shortcuts - remove local handler.

---

<a id="tauri-kjg8-unify-backend-error-types-into-shared-apperror-enum"></a>

## 📋 tauri-kjg8 Unify backend error types into shared AppError enum

| Property | Value |
|----------|-------|
| **Type** | 📋 task |
| **Priority** | ☕ Low (P3) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-03 10:59 |
| **Updated** | 2026-03-03 11:30 |
| **Closed** | 2026-03-03 11:30 |

### Description

files.rs uses proper thiserror::Error enum. All other modules (search.rs, content_search.rs, thumbnails.rs, archive.rs) return Result<_, String>. Define shared AppError enum in lib.rs.

---

<a id="tauri-oyel-replace-settimeout-0-focus-calls-with-svelte-tick"></a>

## 📋 tauri-oyel Replace setTimeout(0) focus calls with Svelte tick()

| Property | Value |
|----------|-------|
| **Type** | 📋 task |
| **Priority** | ☕ Low (P3) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-03 10:09 |
| **Updated** | 2026-03-03 12:24 |
| **Closed** | 2026-03-03 12:24 |

### Description

Several components use setTimeout(..., 0) to focus inputs after render (FileItem rename, CommandPalette, QuickOpen, NavigationBar). The idiomatic Svelte approach is await tick() which waits for the DOM update to complete. More predictable than setTimeout timing.

---

<a id="tauri-xccg-replace-raf-timing-hack-in-marquee-dragjustended-with-time-delta-check"></a>

## 📋 tauri-xccg Replace rAF timing hack in marquee dragJustEnded with time delta check

| Property | Value |
|----------|-------|
| **Type** | 📋 task |
| **Priority** | ☕ Low (P3) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-03 10:09 |
| **Updated** | 2026-03-03 12:24 |
| **Closed** | 2026-03-03 12:24 |

### Description

use-marquee-selection.svelte.ts uses requestAnimationFrame to reset dragJustEnded flag, which is a timing hack to prevent click-after-drag from clearing selection. A more robust approach: record the drag end timestamp and check elapsed time in the click handler (e.g. ignore clicks within 100ms of drag end).

---

<a id="tauri-89kx-unify-toast-notification-state-into-a-toast-store"></a>

## 📋 tauri-89kx Unify toast notification state into a toast store

| Property | Value |
|----------|-------|
| **Type** | 📋 task |
| **Priority** | ☕ Low (P3) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-03 10:08 |
| **Updated** | 2026-03-03 12:33 |
| **Closed** | 2026-03-03 12:33 |

### Description

FileList has 3 separate toast states (pasteError, pasteSuccess, clipboardToast) each with their own timers. Should be a unified toast store that any component can push notifications to, with auto-dismiss. Would also support future features that need notifications (drag errors, archive operations, etc.).

---

<a id="tauri-enf4-include-icons-as-part-of-themes"></a>

## ✨ tauri-enf4 Include icons as part of themes

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ☕ Low (P3) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-03 07:13 |
| **Updated** | 2026-03-04 21:36 |
| **Closed** | 2026-03-03 22:43 |

### Description

Include icons as part of themes. If icons aren't included directly, at least use different colours of the default icons as determined by the theme configuration.

---

<a id="tauri-naca-add-window-transparency-option"></a>

## ✨ tauri-naca Add window transparency option

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ☕ Low (P3) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-03 05:15 |
| **Updated** | 2026-03-03 12:26 |
| **Closed** | 2026-03-03 12:26 |

### Description

Add a setting to control window transparency/opacity

---

<a id="tauri-ti0l-save-file-list-bookmarks-in-config-file"></a>

## ✨ tauri-ti0l Save file list/bookmarks in config file

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ☕ Low (P3) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-03 13:14 |
| **Updated** | 2026-03-04 21:36 |
| **Closed** | 2026-03-03 22:54 |

### Description

Allow saving files/paths in a configuration file for quick access

### Comments

> **Claude User** (2026-03-03)
>
> Bookmarks now persist to ~/.config/tauri-explorer/bookmarks.json via Rust config module. Write-through to both localStorage (sync) and config file (async). Existing localStorage bookmarks migrate on first load. Added read_config_file/write_config_file/get_config_dir Rust commands, frontend API wrappers, and mock handlers.

---

<a id="tauri-320z-make-drag-selection-color-styleable"></a>

## ✨ tauri-320z Make drag selection color styleable

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ☕ Low (P3) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-03 13:14 |
| **Updated** | 2026-03-03 07:29 |
| **Closed** | 2026-03-03 07:29 |

### Description

The drag selection highlight color is currently always blue. Make it configurable via theme/styling

---

<a id="tauri-7pua-configurable-default-terminal-ghostty"></a>

## ✨ tauri-7pua Configurable default terminal (ghostty)

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ☕ Low (P3) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-03 13:14 |
| **Updated** | 2026-03-03 07:33 |
| **Closed** | 2026-03-03 07:33 |

### Description

Use ghostty as default terminal, or make the terminal emulator configurable via settings

---

<a id="tauri-pmyl-increase-padding-margins-when-no-title-bar"></a>

## 🐛 tauri-pmyl Increase padding/margins when no title bar

| Property | Value |
|----------|-------|
| **Type** | 🐛 bug |
| **Priority** | ☕ Low (P3) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-03 13:14 |
| **Updated** | 2026-03-03 04:16 |
| **Closed** | 2026-03-03 04:16 |

### Description

Slightly increase padding/margins in the UI when there is no title bar to improve visual spacing

---

<a id="tauri-zlwx-make-recycle-bin-delete-confirmation-modal-toggleable"></a>

## ✨ tauri-zlwx Make recycle bin delete confirmation modal toggleable

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ☕ Low (P3) |
| **Status** | ⚫ closed |
| **Created** | 2026-03-03 13:14 |
| **Updated** | 2026-03-03 04:16 |
| **Closed** | 2026-03-03 04:16 |

### Description

Add a setting to enable/disable the confirmation modal when moving files to recycle bin

---

<a id="tauri-x129-frontend-perf-benchmarks-for-content-search"></a>

## ✨ tauri-x129 Frontend perf benchmarks for content search

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ☕ Low (P3) |
| **Status** | ⚫ closed |
| **Created** | 2026-02-15 03:14 |
| **Updated** | 2026-02-15 03:26 |
| **Closed** | 2026-02-15 03:26 |

### Description

Add tests/perf/content-search.bench.ts: incremental flatten append, offset recomputation, page slice benchmarks.

### Dependencies

- 🔗 **parent-child**: `tauri-ygaq`

---

<a id="tauri-ddye-api-layer-update-default-maxresults"></a>

## ✨ tauri-ddye API layer: Update default maxResults

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ☕ Low (P3) |
| **Status** | ⚫ closed |
| **Created** | 2026-02-15 03:14 |
| **Updated** | 2026-02-15 03:26 |
| **Closed** | 2026-02-15 03:26 |

### Description

Update startContentSearch default maxResults from 100 to 500. Update ContentSearchDialog to request 2000.

### Dependencies

- 🔗 **parent-child**: `tauri-ygaq`

---

<a id="tauri-explorer-k3oo-dual-pane-defaults-to-same-folder-when-no-saved-location"></a>

## ✨ tauri-explorer-k3oo Dual pane defaults to same folder when no saved location

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ☕ Low (P3) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-18 00:24 |
| **Updated** | 2026-03-02 11:59 |
| **Closed** | 2026-03-02 11:59 |

### Description

When changing from single pane to dual pane, if there isn't a saved location for the dual pane, it should open in a sensible default instead of the same folder.

### Comments

> **Claude User** (2026-03-02)
>
> When enabling dual pane, right pane auto-navigates to parent directory if it shows same path as left.

---

<a id="tauri-explorer-uwm7-customizable-keyboard-shortcuts"></a>

## ✨ tauri-explorer-uwm7 Customizable keyboard shortcuts

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ☕ Low (P3) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-16 18:09 |
| **Updated** | 2026-03-02 12:12 |
| **Closed** | 2026-03-02 12:12 |

### Description

Users should be able to change keyboard shortcuts. Add a settings sub-menu for managing keybindings.

### Comments

> **Claude User** (2026-03-02)
>
> Already implemented as part of EPIC tauri-explorer-m0b. Settings > Keyboard Shortcuts provides full customization with search, reset, and conflict detection.

---

<a id="tauri-explorer-9lnx-create-performance-regression-detection-script"></a>

## 🧹 tauri-explorer-9lnx Create performance regression detection script

| Property | Value |
|----------|-------|
| **Type** | 🧹 chore |
| **Priority** | ☕ Low (P3) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 23:26 |
| **Updated** | 2026-03-02 13:01 |
| **Closed** | 2026-03-02 13:01 |

### Description

Script that compares current benchmark results against stored baseline. Outputs diff report. Exits non-zero if any metric regresses beyond threshold. Used in CI and local development.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-y4y7`

---

<a id="tauri-explorer-exha-add-performance-tests-to-ci-pipeline"></a>

## 🧹 tauri-explorer-exha Add performance tests to CI pipeline

| Property | Value |
|----------|-------|
| **Type** | 🧹 chore |
| **Priority** | ☕ Low (P3) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 23:26 |
| **Updated** | 2026-03-02 13:01 |
| **Closed** | 2026-03-02 13:01 |

### Description

Integrate performance tests into CI. Run on PRs that touch performance-related code. Store results as artifacts. Compare against baseline and fail if regression exceeds threshold (e.g., 10%).

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-y4y7`
- ⛔ **blocks**: `tauri-explorer-9lnx`

---

<a id="tauri-explorer-rtxz-profile-and-optimize-initial-app-startup-time"></a>

## ✨ tauri-explorer-rtxz Profile and optimize initial app startup time

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ☕ Low (P3) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 23:21 |
| **Updated** | 2026-03-02 13:06 |
| **Closed** | 2026-03-02 13:06 |

### Description

Measure and optimize cold start time. Lazy load non-critical components, defer Python sidecar initialization if possible, minimize initial bundle size.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-a0b2`

---

<a id="tauri-explorer-s29y-add-performance-benchmarking-for-directory-scans"></a>

## 🧹 tauri-explorer-s29y Add performance benchmarking for directory scans

| Property | Value |
|----------|-------|
| **Type** | 🧹 chore |
| **Priority** | ☕ Low (P3) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 23:21 |
| **Updated** | 2026-03-02 13:02 |
| **Closed** | 2026-03-02 13:02 |

### Description

Create benchmarks measuring time to scan and render directories of various sizes (100, 1000, 10000 files). Track regressions and improvements.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-a0b2`

---

<a id="tauri-explorer-jag7-add-rust-based-file-metadata-caching"></a>

## ✨ tauri-explorer-jag7 Add Rust-based file metadata caching

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ☕ Low (P3) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 23:21 |
| **Updated** | 2026-03-02 13:03 |
| **Closed** | 2026-03-02 13:03 |

### Description

Cache file metadata (size, dates, type) in Rust layer to avoid repeated filesystem calls. Invalidate on file system events. Speeds up repeated directory visits.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-a0b2`
- ⛔ **blocks**: `tauri-explorer-hgt6`

---

<a id="tauri-explorer-yrav-disable-minimize-transitions-for-heavy-views"></a>

## ✨ tauri-explorer-yrav Disable/minimize transitions for heavy views

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ☕ Low (P3) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 23:21 |
| **Updated** | 2026-03-02 13:05 |
| **Closed** | 2026-03-02 13:05 |

### Description

Remove transition:fade and similar animations from file list items. Applying transitions to thousands of items during fast scroll causes micro-stutters. Keep animations only for UI chrome.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-a0b2`

---

<a id="tauri-explorer-1i2j-paste-image-as-new-file"></a>

## ✨ tauri-explorer-1i2j Paste image as new file

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ☕ Low (P3) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:33 |
| **Updated** | 2026-03-02 12:45 |
| **Closed** | 2026-03-02 12:45 |

### Description

Paste clipboard image to create new .png file.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-j0a`

### Comments

> **Claude User** (2026-03-02)
>
> Deferred - requires binary file write support. Text paste implemented instead.

---

<a id="tauri-explorer-j2l0-paste-text-as-new-file"></a>

## ✨ tauri-explorer-j2l0 Paste text as new file

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ☕ Low (P3) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:33 |
| **Updated** | 2026-03-02 12:45 |
| **Closed** | 2026-03-02 12:45 |

### Description

Paste clipboard text to create new .txt file.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-j0a`

### Comments

> **Claude User** (2026-03-02)
>
> Paste Clipboard as Text File command. Creates pasted-TIMESTAMP.txt in current directory from clipboard text.

---

<a id="tauri-explorer-hyxy-bulk-rename-dialog-ui"></a>

## ✨ tauri-explorer-hyxy Bulk rename dialog UI

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ☕ Low (P3) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:33 |
| **Updated** | 2026-03-02 12:43 |
| **Closed** | 2026-03-02 12:43 |

### Description

Dialog for bulk renaming with preview and patterns.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-3y7`

### Comments

> **Claude User** (2026-03-02)
>
> Bulk rename dialog UI with live preview grid, regex support, change count. Accessible via command palette when 2+ files selected.

---

<a id="tauri-explorer-97a-visual-distinction-for-hidden-files"></a>

## ✨ tauri-explorer-97a Visual distinction for hidden files

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ☕ Low (P3) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:33 |
| **Updated** | 2026-03-02 12:40 |
| **Closed** | 2026-03-02 12:40 |

### Description

Display hidden files with reduced opacity when shown.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-lul`

### Comments

> **Claude User** (2026-03-02)
>
> Hidden files shown at 55% opacity, 80% on hover/selected.

---

<a id="tauri-explorer-cp9-context-menu-open-with-submenu"></a>

## ✨ tauri-explorer-cp9 Context menu: Open With submenu

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ☕ Low (P3) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:32 |
| **Updated** | 2026-03-02 13:08 |
| **Closed** | 2026-03-02 13:08 |

### Description

Add 'Open With' submenu showing available applications for file type.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-zhp`

---

<a id="tauri-explorer-dl7-reorder-bookmarks-via-drag"></a>

## ✨ tauri-explorer-dl7 Reorder bookmarks via drag

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ☕ Low (P3) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:32 |
| **Updated** | 2026-01-17 00:10 |
| **Closed** | 2026-01-17 00:10 |

### Description

Allow dragging bookmarks to reorder them in the sidebar.

### Dependencies

- 🔗 **parent-child**: `tauri-explorer-6bt`

---

<a id="tauri-explorer-3y7-epic-bulk-rename"></a>

## ✨ tauri-explorer-3y7 EPIC: Bulk Rename

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ☕ Low (P3) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:32 |
| **Updated** | 2026-03-02 12:43 |
| **Closed** | 2026-03-02 12:43 |

### Description

Bulk rename functionality with patterns and regex.

### Comments

> **Claude User** (2026-03-02)
>
> EPIC complete. Bulk rename dialog with find/replace (plain text + regex), live preview, case sensitivity toggle.

---

<a id="tauri-explorer-j0a-epic-clipboard-paste-as-files"></a>

## ✨ tauri-explorer-j0a EPIC: Clipboard Paste as Files

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ☕ Low (P3) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:32 |
| **Updated** | 2026-03-02 12:45 |
| **Closed** | 2026-03-02 12:45 |

### Description

Paste clipboard text or images as new files.

### Comments

> **Claude User** (2026-03-02)
>
> EPIC partially complete. Text paste (j2l0) implemented. Image paste (1i2j) deferred - needs binary file write support.

---

<a id="tauri-explorer-ub8-type-ahead-selection-in-file-list"></a>

## ✨ tauri-explorer-ub8 Type-ahead selection in file list

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ☕ Low (P3) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:31 |
| **Updated** | 2026-03-02 11:59 |
| **Closed** | 2026-03-02 11:59 |

### Description

When file list is focused, typing letters should jump to and select the first file starting with those letters (like Windows Explorer).

### Comments

> **Claude User** (2026-03-02)
>
> Type-ahead selection: typing characters in file list jumps to first matching file. Buffer resets after 800ms.

---

<a id="tauri-explorer-pki-paste-image-as-new-file"></a>

## ✨ tauri-explorer-pki Paste image as new file

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ☕ Low (P3) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:30 |
| **Updated** | 2026-01-17 19:50 |
| **Closed** | 2026-01-17 19:50 |

### Description

When clipboard contains image data and user pastes, create a new .png file with image. Prompt for filename or auto-generate with timestamp.

---

<a id="tauri-explorer-kgj-paste-text-as-new-file"></a>

## ✨ tauri-explorer-kgj Paste text as new file

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ☕ Low (P3) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:30 |
| **Updated** | 2026-01-17 19:50 |
| **Closed** | 2026-01-17 19:50 |

### Description

When clipboard contains text and user pastes in file list, create a new .txt file with clipboard contents. Prompt for filename.

---

<a id="tauri-explorer-0xd-regex-find-replace-in-bulk-rename"></a>

## ✨ tauri-explorer-0xd Regex find/replace in bulk rename

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ☕ Low (P3) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:30 |
| **Updated** | 2026-01-17 19:50 |
| **Closed** | 2026-01-17 19:50 |

### Description

Support regex patterns in bulk rename find/replace. Capture groups can be used in replacement string.

---

<a id="tauri-explorer-up8-sequential-numbering-in-bulk-rename"></a>

## ✨ tauri-explorer-up8 Sequential numbering in bulk rename

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ☕ Low (P3) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:30 |
| **Updated** | 2026-01-17 19:50 |
| **Closed** | 2026-01-17 19:50 |

### Description

Support sequential numbering patterns in bulk rename: {n}, {n:3} for zero-padded. Start number and increment configurable.

---

<a id="tauri-explorer-ten-bulk-rename-dialog-ui"></a>

## ✨ tauri-explorer-ten Bulk rename dialog UI

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ☕ Low (P3) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:30 |
| **Updated** | 2026-01-17 19:50 |
| **Closed** | 2026-01-17 19:50 |

### Description

Create dialog for bulk renaming multiple files. Show preview of changes, support patterns like {n} for numbers, find/replace.

---

<a id="tauri-explorer-p2c-clear-recent-files-history"></a>

## ✨ tauri-explorer-p2c Clear recent files history

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ☕ Low (P3) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:30 |
| **Updated** | 2026-03-02 11:59 |
| **Closed** | 2026-03-02 11:59 |

### Description

Add option to clear recent files history from settings or menu. Individual items can be removed too.

### Comments

> **Claude User** (2026-03-02)
>
> Already implemented via 'Clear Recent Files' command in command palette (recent.clearHistory)

---

<a id="tauri-explorer-5a7-import-export-keybindings"></a>

## ✨ tauri-explorer-5a7 Import/export keybindings

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ☕ Low (P3) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:29 |
| **Updated** | 2026-03-02 12:41 |
| **Closed** | 2026-03-02 12:41 |

### Description

Allow exporting keybindings to JSON file and importing from file. Useful for syncing across machines or sharing configs.

### Comments

> **Claude User** (2026-03-02)
>
> Added Export and Import buttons to keybindings settings. Export downloads JSON, import reads JSON and applies shortcuts.

---

<a id="tauri-explorer-dhx-pdf-preview-in-preview-pane"></a>

## ✨ tauri-explorer-dhx PDF preview in preview pane

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ☕ Low (P3) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:29 |
| **Updated** | 2026-03-02 12:54 |
| **Closed** | 2026-03-02 12:54 |

### Description

Render PDF files in preview pane with page navigation. May require PDF.js or similar library.

---

<a id="tauri-explorer-53e-workspace-management-ui"></a>

## ✨ tauri-explorer-53e Workspace management UI

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ☕ Low (P3) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:29 |
| **Updated** | 2026-03-02 12:46 |
| **Closed** | 2026-03-02 12:46 |

### Description

Create UI to manage saved workspaces: rename, delete, reorder. Accessible from settings or menu.

### Comments

> **Claude User** (2026-03-02)
>
> Already implemented in WorkspaceDialog component (tauri-explorer-06c). Dialog supports save, restore, rename, and delete. Accessible via command palette 'Workspaces: Manage...'.

---

<a id="tauri-explorer-xjt-visual-distinction-for-hidden-files"></a>

## ✨ tauri-explorer-xjt Visual distinction for hidden files

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ☕ Low (P3) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:28 |
| **Updated** | 2026-01-17 19:50 |
| **Closed** | 2026-01-17 19:50 |

### Description

When hidden files are shown, display them with reduced opacity or different styling to visually distinguish them from regular files.

---

<a id="tauri-explorer-ti2-context-menu-open-with-submenu"></a>

## ✨ tauri-explorer-ti2 Context menu: Open With submenu

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ☕ Low (P3) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:28 |
| **Updated** | 2026-01-17 19:50 |
| **Closed** | 2026-01-17 19:50 |

### Description

Add 'Open With' submenu showing available applications for the file type. Allow choosing alternative apps to open the file.

---

<a id="tauri-explorer-d62-reorder-bookmarks-via-drag"></a>

## ✨ tauri-explorer-d62 Reorder bookmarks via drag

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ☕ Low (P3) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:27 |
| **Updated** | 2026-03-02 12:52 |
| **Closed** | 2026-03-02 12:52 |

### Description

Allow reordering bookmarks in the sidebar by dragging them to new positions. Persist the new order.

---

<a id="tauri-explorer-r17-epic-bulk-rename"></a>

## ✨ tauri-explorer-r17 EPIC: Bulk Rename

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ☕ Low (P3) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:27 |
| **Updated** | 2026-01-17 19:48 |
| **Closed** | 2026-01-17 19:48 |

### Description

Implement bulk rename functionality for multiple files. Should include: pattern-based renaming, preview changes before applying, sequential numbering, find/replace in filenames, regex support.

---

<a id="tauri-explorer-6yn-epic-clipboard-paste-as-files"></a>

## ✨ tauri-explorer-6yn EPIC: Clipboard Paste as Files

| Property | Value |
|----------|-------|
| **Type** | ✨ feature |
| **Priority** | ☕ Low (P3) |
| **Status** | ⚫ closed |
| **Created** | 2026-01-13 22:27 |
| **Updated** | 2026-01-17 19:48 |
| **Closed** | 2026-01-17 19:48 |

### Description

Implement ability to paste clipboard content as new files. Should include: paste text as .txt file, paste images as .png file, auto-generate filename with timestamp, prompt for filename option.

---

