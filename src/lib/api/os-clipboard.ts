/**
 * OS clipboard API. File lists go through the native revisioned clipboard
 * worker (`clipboard_publish` / `snapshot` / `compare_and_clear` / `rekey`),
 * which owns ordering across windows and Cut identity (#844, #865). Failures
 * carry a reason (e.g. "wl-copy is not installed") so callers can surface it
 * instead of a silent no-op copy (#279).
 */

import { extractError, invoke } from "./common";

export type OsClipboardResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Read text for terminal paste when WebKit denies the browser Clipboard API. */
export async function osClipboardReadText(): Promise<OsClipboardResult<string>> {
  try {
    return { ok: true, data: await invoke<string>("clipboard_read_text") };
  } catch (error) {
    return { ok: false, error: extractError(error) };
  }
}

export interface NativeClipboardSnapshot {
  revision: number;
  entries: import("$lib/domain/file").FileEntry[] | null;
  paths: string[];
  operation: "copy" | "cut" | null;
  mirrorError: string | null;
}

export function osClipboardPublish(
  entries: import("$lib/domain/file").FileEntry[],
  operation: "copy" | "cut",
): Promise<NativeClipboardSnapshot> {
  return invoke<NativeClipboardSnapshot>("clipboard_publish", { entries, operation });
}

export function osClipboardSnapshot(): Promise<NativeClipboardSnapshot> {
  return invoke<NativeClipboardSnapshot>("clipboard_snapshot");
}

export function osClipboardCompareAndClear(revision: number): Promise<boolean> {
  return invoke<boolean>("clipboard_compare_and_clear", { revision });
}

export function osClipboardRekey(
  revision: number,
  oldPath: string,
  entry: import("$lib/domain/file").FileEntry,
): Promise<NativeClipboardSnapshot | null> {
  return invoke<NativeClipboardSnapshot | null>("clipboard_rekey", { revision, oldPath, entry });
}
