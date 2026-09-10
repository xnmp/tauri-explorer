/**
 * Tauri command failures arrive as serialized AppError objects
 * ({ kind, message }) — they must surface as the message, never
 * "[object Object]" (#401).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("$lib/api/common", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { osClipboardReadFiles, osClipboardWriteFiles } from "$lib/api/os-clipboard";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("os-clipboard error rendering (#401)", () => {
  it("extracts the message from a serialized AppError object", async () => {
    invokeMock.mockRejectedValue({ kind: "other", message: "pngpaste is not installed" });
    const result = await osClipboardReadFiles();
    expect(result).toEqual({ ok: false, error: "pngpaste is not installed" });
  });

  it("never renders [object Object] for unknown object shapes", async () => {
    invokeMock.mockRejectedValue({ weird: { nested: true } });
    const result = await osClipboardWriteFiles(["/a"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain("[object Object]");
      expect(result.error).toContain("weird");
    }
  });

  it("keeps plain strings and Error messages as-is", async () => {
    invokeMock.mockRejectedValue("plain failure");
    expect(await osClipboardReadFiles()).toEqual({ ok: false, error: "plain failure" });
    invokeMock.mockRejectedValue(new Error("boom"));
    expect(await osClipboardReadFiles()).toEqual({ ok: false, error: "boom" });
  });
});
