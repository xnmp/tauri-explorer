# #1116 — "hidden files aren't showing on Linux, no way to enable"

- The Rust listing (`scan_directory_parallel`, jwalk `skip_hidden(false)`) returns dotfiles on every platform; hiding is purely frontend (`filterHidden` via `settingsStore.showHidden`). A Linux-only listing bug was ruled out before touching anything.
- The toggle already existed (Settings > Behavior, Ctrl+H, palette) but nothing near the file list advertised it. The fix is discoverability: the background right-click menu's View section carries a "Show hidden files" `menuitemcheckbox` bound to the same `settingsStore.showHidden`.
- The browser mock home (`/home/user`) holds a `.config` folder, which is what `e2e/show-hidden-context-menu.spec.ts` asserts against. Do not add more dotfiles there casually: many specs count entries.
