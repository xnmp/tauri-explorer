/**
 * System/window plumbing — talks to the OS or the window shell, not the
 * filesystem.
 * Issue: refactor/finish-api-files-split-into-open-and-system-modules (#282)
 *
 * Feature consumers import this module directly.
 */

import { invoke, extractError, type ApiResult } from "./common";

/** File-picker portal window → backend: deliver the user's choice.
 *  `paths` are absolute filesystem paths; `cancelled` aborts the request. */
export async function pickerRespond(
  token: string,
  paths: string[],
  cancelled: boolean,
): Promise<void> {
  try {
    await invoke("picker_respond", { token, paths, cancelled });
  } catch {
    // Browser/mock mode — the e2e mock records the call instead.
  }
}

export async function setWindowTheme(theme: "light" | "dark"): Promise<void> {
  try {
    await invoke<void>("set_window_theme", { theme });
  } catch {
    // Non-critical — only affects vibrancy appearance
  }
}

/**
 * Set an explicit ffmpeg binary path for video/audio thumbnails (empty string
 * clears it and reverts to auto-detection). Best-effort; ignores errors.
 */
export async function setFfmpegPath(path: string): Promise<void> {
  try {
    await invoke("set_ffmpeg_path", { path });
  } catch {
    // Not in Tauri runtime or command unavailable — ignore.
  }
}

export async function setAsWallpaper(path: string): Promise<ApiResult<void>> {
  try {
    await invoke("set_as_wallpaper", { path });
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}
