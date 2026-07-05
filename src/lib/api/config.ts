/**
 * API client for JSON config persistence and user theme CSS files.
 * Issue: refactor/audit-tier4-splits (#212)
 */

import { invoke, extractError, type ApiResult } from "./common";

/**
 * Read a JSON config file from the app config directory.
 * Returns empty string if file doesn't exist.
 */
export async function readConfigFile(filename: string): Promise<ApiResult<string>> {
  try {
    const data = await invoke<string>("read_config_file", { filename });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

/**
 * Write a JSON config file to the app config directory.
 */
export async function writeConfigFile(filename: string, data: string): Promise<ApiResult<void>> {
  try {
    await invoke("write_config_file", { filename, data });
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

/**
 * List user theme CSS files from ~/.config/tauri-explorer/themes/.
 * Returns array of [filename, cssContent] pairs.
 */
export async function listUserThemes(): Promise<ApiResult<[string, string][]>> {
  try {
    const data = await invoke<[string, string][]>("list_user_themes");
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

/**
 * Write a user theme CSS file to ~/.config/tauri-explorer/themes/.
 * Rejects if the write fails so callers can surface the error.
 */
export async function writeThemeFile(filename: string, data: string): Promise<void> {
  await invoke("write_theme_file", { filename, data });
}
