import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("$lib/api/common", () => ({
  invoke: invokeMock,
  extractError: (error: unknown) => error instanceof Error ? error.message : String(error),
  virtualPathGuard: () => null,
  dataUriToBlobUrl: () => "blob:preview",
}));

vi.mock("$lib/plugins/fs-providers", () => ({ providerFor: () => undefined }));

import { readImageAsBlobUrl, readTextFile, startStreamingDirectory } from "$lib/api/files";

describe("preview and directory IPC instrumentation (#497)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("records a failed text preview request with its path and backend error", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    invokeMock.mockRejectedValueOnce(new Error("WSL file unavailable"));

    await expect(readTextFile("\\\\wsl.localhost\\Ubuntu\\home\\me\\note.md", 512)).resolves.toEqual({
      ok: false,
      error: "WSL file unavailable",
    });

    expect(warning).toHaveBeenCalledWith(
      "[preview] read_text_file failed",
      expect.objectContaining({
        path: "\\\\wsl.localhost\\Ubuntu\\home\\me\\note.md",
        maxBytes: 512,
        error: "WSL file unavailable",
      }),
    );
    warning.mockRestore();
  });

  it("records a failed image fallback request with its path and backend error", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    invokeMock.mockRejectedValueOnce(new Error("cloud file is offline"));

    await expect(readImageAsBlobUrl("C:\\Users\\me\\OneDrive\\photo.jpg")).resolves.toEqual({
      ok: false,
      error: "cloud file is offline",
    });

    expect(warning).toHaveBeenCalledWith(
      "[preview] read_image_data_url failed",
      expect.objectContaining({
        path: "C:\\Users\\me\\OneDrive\\photo.jpg",
        error: "cloud file is offline",
      }),
    );
    warning.mockRestore();
  });

  it("records a failed directory navigation IPC request with its path and error", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    invokeMock.mockRejectedValueOnce(new Error("permission denied"));

    await expect(startStreamingDirectory("/mnt/wsl/project")).resolves.toEqual({
      ok: false,
      error: "permission denied",
    });

    expect(warning).toHaveBeenCalledWith(
      "[navigation] start_streaming_directory failed",
      expect.objectContaining({ path: "/mnt/wsl/project", error: "permission denied" }),
    );
    warning.mockRestore();
  });

  it("records completed preview and directory requests with their paths and outcomes", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    invokeMock
      .mockResolvedValueOnce("preview text")
      .mockResolvedValueOnce({ path: "/tmp/folder", entries: [], listing_id: null });

    await expect(readTextFile("/tmp/note.md")).resolves.toEqual({ ok: true, data: "preview text" });
    await expect(startStreamingDirectory("/tmp/folder")).resolves.toMatchObject({ ok: true });

    expect(debug).toHaveBeenCalledWith(
      "[preview] read_text_file completed",
      expect.objectContaining({ path: "/tmp/note.md", bytes: 12 }),
    );
    expect(debug).toHaveBeenCalledWith(
      "[navigation] start_streaming_directory completed",
      expect.objectContaining({ path: "/tmp/folder", listingId: null, entries: 0 }),
    );
    debug.mockRestore();
  });
});
