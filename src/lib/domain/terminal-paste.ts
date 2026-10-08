/**
 * Terminal paste (#374, #732, #882): where the text comes from on each
 * platform, and the bytes a paste sends to the shell.
 */

export type TerminalPastePlatform = "windows" | "mac" | "linux";

export interface TerminalPasteSources {
  /** The webview's Clipboard API; may be denied or absent. */
  readBrowser(): Promise<string>;
  /** The native desktop clipboard bridge. */
  readNative(): Promise<{ ok: true; data: string } | { ok: false; error: string }>;
}

export type TerminalPasteRead = { ok: true; text: string } | { ok: false; error: string };

/**
 * Read the text to paste. WebKitGTK can deny the browser API outright (#732),
 * so Linux prefers the native desktop clipboard and falls back to the browser.
 * Windows and macOS keep the fast browser path and use the native bridge
 * after a permission failure. When every source fails, the native reason is
 * reported, because it names what is missing (such as a clipboard tool).
 */
export async function readTerminalPasteText(
  platform: TerminalPastePlatform,
  sources: TerminalPasteSources,
): Promise<TerminalPasteRead> {
  const browser = async (): Promise<TerminalPasteRead | null> => {
    try {
      return { ok: true, text: await sources.readBrowser() };
    } catch {
      return null;
    }
  };
  if (platform !== "linux") {
    const read = await browser();
    if (read) return read;
  }
  let native: Awaited<ReturnType<TerminalPasteSources["readNative"]>>;
  try {
    native = await sources.readNative();
  } catch (error) {
    native = { ok: false, error: String(error) };
  }
  if (native.ok) return { ok: true, text: native.data };
  if (platform === "linux") {
    const read = await browser();
    if (read) return read;
  }
  return { ok: false, error: native.error };
}

/**
 * The bytes a paste sends, as xterm.js's own `paste()` builds them: line
 * endings become CR, and the text is bracketed when the application enabled
 * bracketed-paste mode (DECSET 2004) so a shell does not run pasted lines.
 */
export function encodeTerminalPaste(text: string, bracketedPasteMode: boolean): string {
  const normalized = text.replace(/\r?\n/g, "\r");
  return bracketedPasteMode ? `\x1b[200~${normalized}\x1b[201~` : normalized;
}
