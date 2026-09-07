/** Clipboard image inspection and paste operations. */
import { invoke, extractError, type ApiResult } from "./common";

export async function clipboardHasImage(): Promise<boolean> {
  try { return await invoke<boolean>("clipboard_has_image"); }
  catch { return false; }
}

export async function clipboardPasteImage(directory: string): Promise<ApiResult<string>> {
  try { return { ok: true, data: await invoke<string>("clipboard_paste_image", { directory }) }; }
  catch (err) { return { ok: false, error: extractError(err) }; }
}
