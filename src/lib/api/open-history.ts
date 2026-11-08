/**
 * IPC for the app-owned file open history (#1525). The document lives in the
 * app data directory (not localStorage) so every window shares one history;
 * `state/open-history.svelte.ts` owns parsing, coalescing and publication.
 */
import { invoke, extractError, type ApiResult } from "./common";

/** The stored document, or "" when there is none (or it is unreadable). */
export async function readOpenHistory(): Promise<ApiResult<string>> {
  try { return { ok: true, data: await invoke<string>("read_open_history") }; }
  catch (error) { return { ok: false, error: extractError(error) }; }
}

export async function writeOpenHistory(data: string): Promise<ApiResult<void>> {
  try {
    await invoke("write_open_history", { data });
    return { ok: true, data: undefined };
  } catch (error) { return { ok: false, error: extractError(error) }; }
}
