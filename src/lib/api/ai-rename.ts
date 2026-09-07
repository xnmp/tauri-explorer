/**
 * IPC wrapper for AI rename suggestions (#145).
 *
 * Thin bridge over the compiled-in `ai_suggest_filenames` Rust command. Kept in
 * its own module (rather than files.ts) since it is plugin-scoped surface.
 */

import { invoke, extractError, type ApiResult } from "./common";

/**
 * Ask the configured model for `count` filename suggestions.
 *
 * @param originalName - current filename (no path)
 * @param contentHint  - optional, already-truncated content signal; only ever
 *                        supplied inside the explicit user action
 * @param count        - number of suggestions to request
 * @param apiKey       - Gemini API key from plugin storage
 */
export async function suggestFilenames(
  originalName: string,
  contentHint: string | undefined,
  count: number,
  apiKey: string,
): Promise<ApiResult<string[]>> {
  try {
    const data = await invoke<string[]>("ai_suggest_filenames", {
      originalName,
      contentHint: contentHint ?? null,
      count,
      apiKey,
    });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}
