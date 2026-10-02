import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("$lib/api/common", async (original) => ({
  ...(await original<typeof import("$lib/api/common")>()),
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
import { clipboardHasImage, clipboardImageStatus, clipboardPasteImage } from "$lib/api/clipboard-image";

beforeEach(() => { invokeMock.mockReset(); });

describe("checked clipboard images", () => {
  it.each([true, false])("retains successful availability %s", async (available) => {
    invokeMock.mockResolvedValue(available);
    expect(await clipboardImageStatus()).toEqual({ ok: true, data: available });
  });

  it("preserves inspection failure while report availability stays best-effort", async () => {
    invokeMock.mockRejectedValue({ kind: "other", message: "clipboard locked" });
    expect(await clipboardImageStatus()).toEqual({ ok: false, error: "clipboard locked" });
    expect(await clipboardHasImage()).toBe(false);
  });

  it("preserves read, encoding and write failure messages", async () => {
    invokeMock.mockRejectedValue({ kind: "other", message: "image encoder failed" });
    expect(await clipboardPasteImage("/destination")).toEqual({ ok: false, error: "image encoder failed" });
  });
});
