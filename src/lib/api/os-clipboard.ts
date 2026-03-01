/**
 * OS Clipboard API for file operations.
 * Issue: tauri-explorer-za55, tauri-explorer-rdra
 *
 * Write uses tauri-plugin-clipboard-x (works cross-platform).
 * Read uses custom Tauri commands that parse Linux clipboard formats
 * (x-special/gnome-copied-files, text/uri-list) via wl-paste/xclip.
 */

import { invoke } from "@tauri-apps/api/core";

/**
 * Check if the OS clipboard contains files.
 * Uses custom Tauri command for Linux MIME type support.
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
 * Read file paths from the OS clipboard.
 * Uses custom Tauri command that reads x-special/gnome-copied-files
 * and text/uri-list formats via wl-paste (Wayland) or xclip (X11).
 */
export async function osClipboardReadFiles(): Promise<string[]> {
  try {
    return await invoke<string[]>("clipboard_read_files");
  } catch (error) {
    console.error("Failed to read files from OS clipboard:", error);
    return [];
  }
}

/**
 * Write file paths to the OS clipboard.
 * Uses custom Tauri command that writes x-special/gnome-copied-files
 * via wl-copy (Wayland) or xclip (X11) for native file manager support.
 */
export async function osClipboardWriteFiles(filePaths: string[]): Promise<boolean> {
  try {
    return await invoke<boolean>("clipboard_write_files", { paths: filePaths });
  } catch (error) {
    console.error("Failed to write files to OS clipboard:", error);
    return false;
  }
}
