/**
 * OS Clipboard API for file operations.
 * Issue: tauri-explorer-za55, tauri-explorer-rdra, #279
 *
 * Read/write use custom Tauri commands that parse Linux clipboard formats
 * (x-special/gnome-copied-files, text/uri-list) via wl-paste/xclip, and
 * CF_HDROP via PowerShell on Windows. Failures carry a reason (e.g.
 * "wl-copy is not installed") so callers can surface it instead of a
 * silent no-op copy (#279).
 */

import { invoke } from "./common";

export type OsClipboardResult<T> = { ok: true; data: T } | { ok: false; error: string };

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  // Tauri command failures arrive as the serialized AppError object
  // ({ kind, message }) — String() would render "[object Object]" (#401).
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === "string") return message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Check if the OS clipboard contains files. A pure probe (menu enablement):
 * failures deliberately read as "no files".
 */
export async function osClipboardHasFiles(): Promise<boolean> {
  try {
    return await invoke<boolean>("clipboard_has_files");
  } catch (error) {
    console.error("Failed to check OS clipboard:", error);
    return false;
  }
}

/**
 * Read file paths from the OS clipboard. `ok: true` with an empty array
 * means the clipboard holds no files; `ok: false` means the clipboard
 * tooling itself failed (missing wl-clipboard/xclip, PowerShell error).
 */
export async function osClipboardReadFiles(): Promise<OsClipboardResult<string[]>> {
  try {
    return { ok: true, data: await invoke<string[]>("clipboard_read_files") };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/**
 * Write file paths to the OS clipboard so external file managers can paste
 * them. Failure carries the reason for the caller to surface.
 */
export async function osClipboardWriteFiles(filePaths: string[]): Promise<OsClipboardResult<void>> {
  try {
    await invoke<void>("clipboard_write_files", { paths: filePaths });
    return { ok: true, data: undefined };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}
