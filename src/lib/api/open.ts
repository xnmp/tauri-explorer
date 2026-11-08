/**
 * Opening files/paths in external programs (default apps, specific apps,
 * image viewers, terminals).
 * Issue: refactor/finish-api-files-split-into-open-and-system-modules (#282)
 *
 * Split out of files.ts; re-exported there so existing importers of
 * Feature consumers import this module directly.
 */

import {
  invoke,
  extractError,
  virtualPathGuard,
  type ApiResult,
} from "./common";
import type { OpenWithApplication } from "$lib/domain/open-with";

/** Successful file launches (#1525): the single seam where the app hands a
 * file to another program. Directory navigation is not an open. Listeners
 * (the open history) run after the launch succeeds and never affect it. */
type LaunchListener = (path: string) => void;
const launchListeners = new Set<LaunchListener>();
export function onFileLaunched(listener: LaunchListener): () => void {
  launchListeners.add(listener);
  return () => launchListeners.delete(listener);
}
function launched(path: string): ApiResult<void> {
  for (const listener of launchListeners) {
    try { listener(path); } catch { /* A listener never fails the launch. */ }
  }
  return { ok: true, data: undefined };
}

export async function listOpenWithApplications(path: string): Promise<ApiResult<OpenWithApplication[]>> {
  const guard = virtualPathGuard(path);
  if (guard) return guard;
  try { return { ok: true, data: await invoke<OpenWithApplication[]>("list_open_with_applications", { path }) }; }
  catch (error) { return { ok: false, error: extractError(error) }; }
}

export async function openFileWithApplication(path: string, applicationId: string): Promise<ApiResult<void>> {
  const guard = virtualPathGuard(path);
  if (guard) return guard;
  try {
    await invoke("open_file_with_application", { path, applicationId });
    return launched(path);
  } catch (error) { return { ok: false, error: extractError(error) }; }
}

/**
 * Open a file in the system's default application.
 *
 * @param path - Full path to file to open
 * @returns Result indicating success or error message
 */
export async function openFile(path: string): Promise<ApiResult<void>> {
  const guard = virtualPathGuard(path);
  if (guard) return guard;
  try {
    await invoke("open_file", { path });
    return launched(path);
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

/** Open the operating system's recycle bin / trash location. */
export async function openRecycleBin(): Promise<ApiResult<void>> {
  try {
    await invoke("open_recycle_bin");
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

/**
 * Open a file at a specific line number using a known text editor.
 * Falls back to default open if no known editor is found.
 */
export async function openFileAtLine(path: string, line: number): Promise<ApiResult<void>> {
  const guard = virtualPathGuard(path);
  if (guard) return guard;
  try {
    await invoke("open_file_at_line", { path, line });
    return launched(path);
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

/**
 * Open a file with a specific application.
 *
 * @param path - Full path to file to open
 * @param app - Application command to open with
 * @returns Result indicating success or error message
 */
export async function openFileWith(path: string, app: string): Promise<ApiResult<void>> {
  const guard = virtualPathGuard(path);
  if (guard) return guard;
  try {
    await invoke("open_file_with", { path, app });
    return launched(path);
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

/**
 * Open an image file with sibling images passed to the viewer,
 * enabling arrow-key navigation in viewers like imv, feh, etc.
 */
export async function openImageWithSiblings(path: string): Promise<ApiResult<void>> {
  const guard = virtualPathGuard(path);
  if (guard) return guard;
  try {
    await invoke("open_image_with_siblings", { path });
    return launched(path);
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

/**
 * Open a terminal at a directory path.
 *
 * @param path - Path (directory or file, uses parent for files)
 * @returns Result indicating success or error message
 */
export async function openInTerminal(path: string, terminal?: string): Promise<ApiResult<void>> {
  try {
    await invoke("open_in_terminal", { path, terminal: terminal || null });
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

/**
 * List terminal emulators that are actually installed on this machine, so the
 * settings UI can offer a dropdown instead of a free-text command.
 */
export async function listInstalledTerminals(): Promise<ApiResult<string[]>> {
  try {
    const data = await invoke<string[]>("list_installed_terminals");
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}
