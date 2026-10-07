# Picker source navigation — 2026-10-07

User requested source-window centering, type-ahead (n → nltk_data), Ctrl+F filter,
and Ctrl+P recent/frequent files/folders. Implemented in the dedicated worktree
`.worktrees/picker-source-navigation`, branch `feat/picker-source-navigation`
from origin/dev 5680ec0c, issue #1003. Main checkout's icon-alternatives edits
were left intact.

## Active local installation

- Binary: /home/chong/.local/lib/tauri-explorer-picker/tauri-explorer
- User D-Bus service: /home/chong/.local/share/dbus-1/services/org.freedesktop.impl.portal.desktop.tauri_explorer.service
- Portal selection: ~/.config/xdg-desktop-portal/portals.conf
- Live Hyprland and chezmoi template retain float=true, omit center=true.
- D-Bus ReloadConfig was necessary after writing the service override; first
  activation still ran /usr/bin/tauri-explorer. Re-activation then verified the
  custom executable and the portal exposed FileChooser version4.
- Normal Explorer windows keep their existing packaged binary/process.
- Activation backups: /tmp/picker-activation-backup-5rdxaqn8. To roll back the
  picker build, remove the user D-Bus service override, ReloadConfig and retire
  only an idle portal-mode process before restarting the desktop portal.

## Behavior and validation

Type a prefix to select a row; Enter opens directories or confirms a selected
file. Prefix resets on directory/column change; selected entries are scrolled
into view and focus follows them. Ctrl+F filters active-column names, Escape
clears the filter first. Ctrl+P starts with shared history and frequent folders,
then merges delayed fuzzy results, deduplicated and capped at20. Quick Open
closes/restores Modal focus before navigating to avoid reactivating an old column.
History refreshes before ranking/addition and persists before terminal response
IPC closes the window.

- 38 targeted Vitest tests passed.
- 18 picker tests passed in Chromium and18 in WebKit.
- Svelte/type checks: zero errors/warnings. Frontend and production native builds
  passed; existing vendor Wry cfg/deprecation warnings remain.
- Parent-identifier contracts passed through rustc --test importing the exact
  production module. Full Rust lib test linking exhausted host disk; removed
  only the generated failed-link object files.
- Independent review found and then verified focus and multiwindow history fixes.
- Native X11 imports the production parenting helper in separate GTK fixture
  processes. Explicit1920x1080 private Xvfb/Openbox yielded source20,40,950,650;
  picker45,85,900,560; both centers495,365. Xlib confirmed real geometry.
  /tmp/pkx/review-acceptance.json and server-windows.log retain proof.
- Private Hyprland could not render due NVIDIA linear GBM allocation. Do not
  claim visual Wayland acceptance. Hyprland0.56.2 WindowTarget.cpp confirms
  parent-centered placement for Wayland floating windows. Backend-mismatched
  external parents (XWayland source/Wayland picker) retain fallback placement.
- Separate-process WebKit localStorage coherence remains unverified; browser
  cross-window refresh/preservation contracts passed. Old main windows do not
  include this branch's new pre-write refresh logic until their app is updated.

Screenshots committed under screenshots/feat/picker-source-navigation/ cover
nltk_data selection, filtering and recent/frequent results. Source centering's
Wayland screenshot checkbox remains open on the issue. No user desktop input,
clipboard operation, window move or workspace switch was automated.

## Private tools / cleanup

Temporary GTK probe: /tmp/picker-native-probe (imports actual production helpers).
Repeat native X11 check with:
`xvfb-run -a -s '-screen 0 1920x1080x24 -nolisten tcp' /tmp/picker-x11-review.sh`
The explicit screen matters: this host's default was640x480, constraining both
windows and producing a vacuous equal-center result that was rejected.
Private probe/compositor sessions were bounded and cleaned up. Throwaway Vite
and Playwright configs on1442 are not part of the implementation.
