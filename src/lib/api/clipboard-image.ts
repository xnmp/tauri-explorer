/** Clipboard image inspection and paste operations. */
import { invoke, extractError, type ApiResult } from "./common";

export async function clipboardHasImage(): Promise<boolean> {
  const result = await clipboardImageStatus();
  return result.ok && result.data;
}

export async function clipboardImageStatus(): Promise<ApiResult<boolean>> {
  try { return { ok: true, data: await invoke<boolean>("clipboard_has_image") }; }
  catch (err) { return { ok: false, error: extractError(err) }; }
}

export async function clipboardPasteImage(directory: string): Promise<ApiResult<string>> {
  try { return { ok: true, data: await invoke<string>("clipboard_paste_image", { directory }) }; }
  catch (err) { return { ok: false, error: extractError(err) }; }
}
