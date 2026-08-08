/**
 * Applies external edits to the config directory without a restart (#599).
 *
 * The Rust watcher (`src-tauri/src/config_watch.rs`) emits
 * `config-file-changed` with a config-dir-relative filename; this module turns
 * that into the store work each file needs.
 *
 * Most settings are consumed reactively, so re-seating the settings object is
 * enough. The two exceptions are imperative and handled explicitly here:
 * the theme is written onto `document.documentElement` rather than read from a
 * rune, and user theme CSS lives in `<style>` elements that have to be
 * re-injected and re-discovered before a theme id can resolve to it.
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { settingsStore } from "./settings.svelte";
import { bookmarksStore } from "./bookmarks.svelte";
import { folderViewsStore } from "./folder-views.svelte";
import { themeStore } from "./theme.svelte";
import { toastStore } from "./toast.svelte";

export const CONFIG_CHANGED_EVENT = "config-file-changed";
const SETTINGS_FILE = "settings.json";
const BOOKMARKS_FILE = "bookmarks.json";
const FOLDER_VIEWS_FILE = "folder-views.json";
const THEME_PREFIX = "themes/";

/**
 * Handle one change notification. Exported for direct testing: it is the whole
 * frontend half of the feature, and driving it through a Tauri event in a test
 * would only prove the event name matches itself.
 */
export async function handleConfigFileChanged(filename: string): Promise<void> {
  if (filename === SETTINGS_FILE) {
    const reason = await settingsStore.reloadFromDisk();
    // Only when the reload actually moved settings — re-applying the theme
    // rewrites DOM attributes and repaints, so a no-op notification (our own
    // save echoing back) must stay a no-op all the way through.
    if (reason === "external-change") {
      themeStore.syncFromSettings();
      return;
    }
    // Someone hand-edited the file into invalid JSON. Silence here reads as
    // "autoreload is broken" rather than "your edit has a typo", and the
    // settings they can see are no longer the ones they just wrote — so this
    // is the one rejection worth surfacing. A truncated mid-save read lands
    // here too, but the trailing debounce makes that rare and the follow-up
    // notification corrects it.
    if (reason === "unusable") {
      toastStore.show(
        "settings.json could not be read — keeping the current settings",
        "error",
        { duration: 6000 },
      );
    }
    return;
  }

  if (filename.startsWith(THEME_PREFIX)) {
    // A user theme's CSS changed, was added, or was removed. initTheme
    // re-injects the CSS, re-discovers the theme list, and re-applies the
    // current id — which is also what makes an edit to the *active* theme
    // repaint rather than sit in the DOM unused.
    await themeStore.initTheme();
    return;
  }

  if (filename === BOOKMARKS_FILE) {
    await bookmarksStore.reloadFromDisk();
    return;
  }

  if (filename === FOLDER_VIEWS_FILE) {
    await folderViewsStore.reloadFromDisk();
  }
}

/**
 * Start applying config-file changes. Returns a stop function.
 *
 * Outside Tauri (browser E2E, unit tests) the event system is unavailable and
 * `listen` rejects; autoreload is simply absent there, exactly as it is when
 * the OS watch could not be created.
 */
export function startConfigWatch(): () => void {
  let unlisten: UnlistenFn | null = null;
  let stopped = false;

  void listen<{ filename: string }>(CONFIG_CHANGED_EVENT, (event) => {
    void handleConfigFileChanged(event.payload.filename);
  })
    .then((fn) => {
      // The caller may have torn down before listen() resolved.
      if (stopped) fn();
      else unlisten = fn;
    })
    .catch(() => {
      unlisten = null;
    });

  return () => {
    stopped = true;
    unlisten?.();
    unlisten = null;
  };
}
