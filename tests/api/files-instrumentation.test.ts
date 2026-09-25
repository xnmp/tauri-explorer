import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, isTauriMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  isTauriMock: vi.fn(() => false),
}));

vi.mock("$lib/api/common", () => ({
  invoke: invokeMock,
  isTauri: isTauriMock,
  extractError: (error: unknown) => error instanceof Error ? error.message : String(error),
  virtualPathGuard: () => null,
  dataUriToBlobUrl: () => "blob:preview",
}));

vi.mock("$lib/api/native-resource-session", () => ({ getNativeResourceSession: async () => "session" }));

vi.mock("$lib/plugins/fs-providers", () => ({ providerFor: () => undefined }));

import { readImageAsBlobUrl, readTextFile, loadDirectory } from "$lib/api/files";

describe("preview and directory IPC instrumentation (#497)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    isTauriMock.mockReturnValue(false);
    invokeMock.mockResolvedValue(undefined);
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
    expect(invokeMock).toHaveBeenCalledWith(
      "log_frontend_error",
      expect.objectContaining({ message: expect.stringContaining("preview read_text_file failed") }),
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
    expect(invokeMock).toHaveBeenCalledWith(
      "log_frontend_error",
      expect.objectContaining({ message: expect.stringContaining("preview read_image_data_url failed") }),
    );
    warning.mockRestore();
  });

  it("records a failed directory navigation IPC request with its path and error", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    invokeMock.mockRejectedValueOnce(new Error("permission denied"));

    await expect(loadDirectory("/mnt/wsl/project")).resolves.toEqual({
      ok: false,
      error: "permission denied",
    });

    expect(warning).toHaveBeenCalledWith(
      "[navigation] list_directory_fresh failed",
      expect.objectContaining({ path: "/mnt/wsl/project", error: "permission denied" }),
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "log_frontend_error",
      expect.objectContaining({ message: expect.stringContaining("navigation list_directory_fresh failed") }),
    );
    warning.mockRestore();
  });

  it("releases an acquired native watch when its compact snapshot cannot be decoded", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    isTauriMock.mockReturnValue(true);
    const lease = { id: "owned-lease", path: "/watched" };
    invokeMock.mockResolvedValueOnce({
      format: "columns-v1", path: "/watched", path_prefix: "/watched/",
      columns: { names: ["file"], kinds: [], sizes: [0], modified: [""] },
      watch_lease: lease,
    });
    const discard = vi.fn();
    try {
      await expect(loadDirectory("/watched", { discard })).resolves.toEqual({
        ok: false, error: "Invalid native directory snapshot",
      });
      expect(discard).toHaveBeenCalledExactlyOnceWith(lease);
      expect(invokeMock).toHaveBeenCalledWith("start_observed_directory", {
        path: "/watched", sessionId: "session",
      });
    } finally {
      warning.mockRestore();
    }
  });

  it("rejects a native observed reply with a missing watch lease without releasing the previous watch", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    isTauriMock.mockReturnValue(true);
    invokeMock.mockResolvedValueOnce({ path: "/watched", entries: [] }); // no watch_lease
    const discard = vi.fn();
    try {
      await expect(loadDirectory("/watched", { discard })).resolves.toEqual({
        ok: false, error: "Invalid native directory watch lease",
      });
      expect(discard).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  it("rejects a native observed reply with a malformed lease id without releasing the previous watch", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    isTauriMock.mockReturnValue(true);
    invokeMock.mockResolvedValueOnce({
      path: "/watched", entries: [], watch_lease: { id: 42, path: "/watched" },
    });
    const discard = vi.fn();
    try {
      await expect(loadDirectory("/watched", { discard })).resolves.toEqual({
        ok: false, error: "Invalid native directory watch lease",
      });
      expect(discard).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  it("rejects a native observed reply with a malformed lease path without releasing the previous watch", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    isTauriMock.mockReturnValue(true);
    invokeMock.mockResolvedValueOnce({
      path: "/watched", entries: [], watch_lease: { id: "owned-lease", path: null },
    });
    const discard = vi.fn();
    try {
      await expect(loadDirectory("/watched", { discard })).resolves.toEqual({
        ok: false, error: "Invalid native directory watch lease",
      });
      expect(discard).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  it("records completed preview and directory requests with their paths and outcomes", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    invokeMock
      .mockResolvedValueOnce("preview text")
      .mockResolvedValueOnce({ path: "/tmp/folder", entries: [] });

    await expect(readTextFile("/tmp/note.md")).resolves.toEqual({ ok: true, data: "preview text" });
    await expect(loadDirectory("/tmp/folder")).resolves.toMatchObject({ ok: true });

    expect(debug).toHaveBeenCalledWith(
      "[preview] read_text_file completed",
      expect.objectContaining({ path: "/tmp/note.md", bytes: 12 }),
    );
    expect(debug).toHaveBeenCalledWith(
      "[navigation] list_directory_fresh completed",
      expect.objectContaining({ path: "/tmp/folder", entries: 0 }),
    );
    expect(debug).toHaveBeenCalledWith(
      "[navigation] list_directory_fresh requested",
      { path: "/tmp/folder" },
    );
    debug.mockRestore();
  });
});
