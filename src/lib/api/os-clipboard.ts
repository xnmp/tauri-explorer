/**
 * OS Clipboard API for file operations.
 * Issue: tauri-explorer-za55, tauri-explorer-rdra
 *
 * Integrates with the system clipboard to allow copying files
 * to/from external applications (Explorer, Finder, etc.)
 */

import {
  hasFiles,
  readFiles,
  writeFiles,
} from "tauri-plugin-clipboard-x-api";

/**
 * Check if the OS clipboard contains files.
 */
export async function osClipboardHasFiles(): Promise<boolean> {
  try {
    return await hasFiles();
  } catch (error) {
    console.error("Failed to check OS clipboard:", error);
    return false;
  }
}

/**
 * Read file paths from the OS clipboard.
 * Returns empty array if no files or on error.
 */
export async function osClipboardReadFiles(): Promise<string[]> {
  try {
    const hasFileContent = await hasFiles();
    if (!hasFileContent) {
      return [];
    }
    const result = await readFiles();
    return result.paths;
  } catch (error) {
    console.error("Failed to read files from OS clipboard:", error);
    return [];
  }
}

/**
 * Write file paths to the OS clipboard.
 * This allows the files to be pasted in other applications.
 */
export async function osClipboardWriteFiles(filePaths: string[]): Promise<boolean> {
  try {
    await writeFiles(filePaths);
    return true;
  } catch (error) {
    console.error("Failed to write files to OS clipboard:", error);
    return false;
  }
}
