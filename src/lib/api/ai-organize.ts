/**
 * IPC wrapper for AI destination suggestions (#158).
 *
 * Thin bridge over the compiled-in `ai_suggest_destination` Rust command.
 * Plugin-scoped surface, so it lives beside ai-rename.ts rather than files.ts.
 */

import { invoke, extractError, type ApiResult } from "./files";

/**
 * Ask the configured model to pick the best destination folders for a file
 * from a caller-supplied candidate list. The backend validates the response
 * against `candidates`, so results are always drawn from it.
 *
 * @param fileName    - current filename (no path)
 * @param contentHint - optional, already-truncated content signal; only ever
 *                      supplied inside the explicit user action
 * @param candidates  - candidate destination directories (absolute paths)
 * @param count       - number of suggestions to request (1-5)
 * @param apiKey      - Gemini API key from plugin storage
 */
export async function suggestDestination(
  fileName: string,
  contentHint: string | undefined,
  candidates: string[],
  count: number,
  apiKey: string,
): Promise<ApiResult<string[]>> {
  try {
    const data = await invoke<string[]>("ai_suggest_destination", {
      fileName,
      contentHint: contentHint ?? null,
      candidates,
      count,
      apiKey,
    });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}
