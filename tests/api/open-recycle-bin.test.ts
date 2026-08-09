import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("$lib/api/common", () => ({
  invoke: invokeMock,
  extractError: (error: unknown) => error instanceof Error ? error.message : String(error),
}));

import { openRecycleBin } from "$lib/api/open";

describe("openRecycleBin", () => {
  beforeEach(() => invokeMock.mockReset());

  it("requests the native recycle-bin surface", async () => {
    invokeMock.mockResolvedValue(undefined);

    await expect(openRecycleBin()).resolves.toEqual({ ok: true, data: undefined });
    expect(invokeMock).toHaveBeenCalledWith("open_recycle_bin");
  });
});
