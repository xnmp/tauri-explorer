/**
 * API client for user layout theme CSS in `<config>/layouts/` (#1306).
 * Imported only by the lazily loaded layout controller and settings UI.
 */

import type { UserLayoutFile } from "$lib/domain/layout-theme";
import { invoke, extractError, type ApiResult } from "./common";

/** Every `.css` file in the layouts folder. Oversized or unreadable files are
 *  listed with `css: null` and an `error`, so the UI can explain them. */
export async function listUserLayouts(): Promise<ApiResult<UserLayoutFile[]>> {
  try {
    return { ok: true, data: await invoke<UserLayoutFile[]>("list_user_layouts") };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

/** Absolute path of the layouts folder, created if it does not exist yet. */
export async function ensureLayoutsDir(): Promise<ApiResult<string>> {
  try {
    return { ok: true, data: await invoke<string>("ensure_layouts_dir") };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}
