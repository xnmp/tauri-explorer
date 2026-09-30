import { describe, expect, it, vi } from "vitest";
import { encodeTerminalPaste, readTerminalPasteText, type TerminalPastePlatform } from "$lib/domain/terminal-paste";

function sources(browser: string | Error, native: string | { error: string } | Error) {
  return {
    readBrowser: vi.fn(async () => {
      if (browser instanceof Error) throw browser;
      return browser;
    }),
    readNative: vi.fn(async () => {
      if (native instanceof Error) throw native;
      return typeof native === "string"
        ? { ok: true as const, data: native }
        : { ok: false as const, error: native.error };
    }),
  };
}

const denied = new Error("NotAllowedError");

describe("terminal paste source", () => {
  it.each<TerminalPastePlatform>(["windows", "mac"])("uses the browser clipboard first on %s", async (platform) => {
    const readers = sources("browser text", "native text");
    await expect(readTerminalPasteText(platform, readers)).resolves.toEqual({ ok: true, text: "browser text" });
    expect(readers.readNative).not.toHaveBeenCalled();
  });

  it.each<TerminalPastePlatform>(["windows", "mac"])("falls back to the native clipboard when %s denies the browser", async (platform) => {
    const readers = sources(denied, "native text");
    await expect(readTerminalPasteText(platform, readers)).resolves.toEqual({ ok: true, text: "native text" });
  });

  it("prefers the native clipboard on Linux, where WebKitGTK can deny the browser (#732)", async () => {
    const readers = sources("browser text", "native text");
    await expect(readTerminalPasteText("linux", readers)).resolves.toEqual({ ok: true, text: "native text" });
    expect(readers.readBrowser).not.toHaveBeenCalled();
  });

  it("falls back to the browser on Linux when the native bridge fails", async () => {
    const readers = sources("browser text", { error: "no clipboard tool" });
    await expect(readTerminalPasteText("linux", readers)).resolves.toEqual({ ok: true, text: "browser text" });
  });

  it.each<TerminalPastePlatform>(["windows", "mac", "linux"])("reports the native reason when every source fails on %s", async (platform) => {
    const readers = sources(denied, { error: "no clipboard tool" });
    await expect(readTerminalPasteText(platform, readers)).resolves.toEqual({ ok: false, error: "no clipboard tool" });
  });

  it("treats a rejected native bridge as a failed source", async () => {
    const readers = sources(denied, new Error("ipc down"));
    await expect(readTerminalPasteText("mac", readers)).resolves.toEqual({ ok: false, error: "Error: ipc down" });
  });

  it("returns an empty clipboard as empty text rather than a failure", async () => {
    const readers = sources("", "");
    await expect(readTerminalPasteText("linux", readers)).resolves.toEqual({ ok: true, text: "" });
  });
});

describe("terminal paste bytes", () => {
  it("turns every line ending into CR, as a typed Enter", () => {
    expect(encodeTerminalPaste("one\ntwo\r\nthree", false)).toBe("one\rtwo\rthree");
  });

  it("brackets the text when the application enabled bracketed paste", () => {
    expect(encodeTerminalPaste("ls\nrm -rf x\n", true)).toBe("\x1b[200~ls\rrm -rf x\r\x1b[201~");
  });

  it("leaves a lone CR and other control bytes untouched", () => {
    expect(encodeTerminalPaste("a\rb\tc", false)).toBe("a\rb\tc");
  });

  it("handles empty text", () => {
    expect(encodeTerminalPaste("", false)).toBe("");
    expect(encodeTerminalPaste("", true)).toBe("\x1b[200~\x1b[201~");
  });
});
