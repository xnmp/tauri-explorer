/**
 * Tests for API client - file operations.
 * Issue: tauri-explorer-nv2y - Updated to test Tauri invoke commands
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Tauri's invoke function
const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

// Import after mocking
import { fetchDirectory, createDirectory, renameEntry, copyEntry, moveEntry, deleteEntry, openFile, getHomeDirectory, fuzzySearch } from "$lib/api/files";

describe("fetchDirectory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns data on success", async () => {
    const mockResponse = {
      path: "/test",
      entries: [
        {
          name: "file.txt",
          path: "/test/file.txt",
          kind: "file",
          size: 100,
          modified: "2025-01-01T00:00:00",
        },
      ],
    };

    mockInvoke.mockResolvedValue(mockResponse);

    const result = await fetchDirectory("/test");

    expect(mockInvoke).toHaveBeenCalledWith("list_directory", { path: "/test" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.path).toBe("/test");
      expect(result.data.entries).toHaveLength(1);
      expect(result.data.entries[0].name).toBe("file.txt");
    }
  });

  it("returns error on invoke failure", async () => {
    mockInvoke.mockRejectedValue("Path not found: /missing");

    const result = await fetchDirectory("/missing");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Path not found");
    }
  });

  it("handles permission denied errors", async () => {
    mockInvoke.mockRejectedValue("Permission denied: /restricted");

    const result = await fetchDirectory("/restricted");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Permission denied");
    }
  });
});

describe("createDirectory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns created entry on success", async () => {
    const mockEntry = {
      name: "new_folder",
      path: "/test/new_folder",
      kind: "directory",
      size: 0,
      modified: "2025-01-01T00:00:00",
    };

    mockInvoke.mockResolvedValue(mockEntry);

    const result = await createDirectory("/test", "new_folder");

    expect(mockInvoke).toHaveBeenCalledWith("create_directory", {
      parentPath: "/test",
      name: "new_folder",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe("new_folder");
      expect(result.data.kind).toBe("directory");
    }
  });

  it("returns error when directory already exists", async () => {
    mockInvoke.mockRejectedValue("Path already exists: /test/existing");

    const result = await createDirectory("/test", "existing");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("already exists");
    }
  });

  it("returns error when parent not found", async () => {
    mockInvoke.mockRejectedValue("Path not found: /nonexistent");

    const result = await createDirectory("/nonexistent", "folder");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("not found");
    }
  });
});

describe("renameEntry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns renamed entry on success", async () => {
    const mockEntry = {
      name: "new_name.txt",
      path: "/test/new_name.txt",
      kind: "file",
      size: 100,
      modified: "2025-01-01T00:00:00",
    };

    mockInvoke.mockResolvedValue(mockEntry);

    const result = await renameEntry("/test/old_name.txt", "new_name.txt");

    expect(mockInvoke).toHaveBeenCalledWith("rename_entry", {
      path: "/test/old_name.txt",
      newName: "new_name.txt",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe("new_name.txt");
    }
  });

  it("returns error on failure", async () => {
    mockInvoke.mockRejectedValue("Target already exists: /test/new_name.txt");

    const result = await renameEntry("/test/file.txt", "new_name.txt");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("already exists");
    }
  });
});

describe("copyEntry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns copied entry on success", async () => {
    const mockEntry = {
      name: "file.txt",
      path: "/dest/file.txt",
      kind: "file",
      size: 100,
      modified: "2025-01-01T00:00:00",
    };

    mockInvoke.mockResolvedValue(mockEntry);

    const result = await copyEntry("/source/file.txt", "/dest");

    expect(mockInvoke).toHaveBeenCalledWith("copy_entry", {
      source: "/source/file.txt",
      destDir: "/dest",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.path).toBe("/dest/file.txt");
    }
  });
});

describe("moveEntry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns moved entry on success", async () => {
    const mockEntry = {
      name: "file.txt",
      path: "/dest/file.txt",
      kind: "file",
      size: 100,
      modified: "2025-01-01T00:00:00",
    };

    mockInvoke.mockResolvedValue(mockEntry);

    const result = await moveEntry("/source/file.txt", "/dest");

    expect(mockInvoke).toHaveBeenCalledWith("move_entry", {
      source: "/source/file.txt",
      destDir: "/dest",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.path).toBe("/dest/file.txt");
    }
  });
});

describe("deleteEntry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns success when file deleted", async () => {
    mockInvoke.mockResolvedValue(undefined);

    const result = await deleteEntry("/test/file.txt");

    expect(mockInvoke).toHaveBeenCalledWith("move_to_trash", {
      path: "/test/file.txt",
    });
    expect(result.ok).toBe(true);
  });

  it("returns error when file not found", async () => {
    mockInvoke.mockRejectedValue("Path does not exist: /test/missing.txt");

    const result = await deleteEntry("/test/missing.txt");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("does not exist");
    }
  });
});

describe("openFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns success when file opened", async () => {
    mockInvoke.mockResolvedValue(undefined);

    const result = await openFile("/test/file.txt");

    expect(mockInvoke).toHaveBeenCalledWith("open_file", {
      path: "/test/file.txt",
    });
    expect(result.ok).toBe(true);
  });
});

describe("getHomeDirectory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns home directory path", async () => {
    mockInvoke.mockResolvedValue("/home/user");

    const result = await getHomeDirectory();

    expect(mockInvoke).toHaveBeenCalledWith("get_home_directory");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBe("/home/user");
    }
  });
});

describe("fuzzySearch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns search results on success", async () => {
    const mockResponse = {
      results: [
        {
          name: "hello.txt",
          path: "/test/hello.txt",
          relativePath: "hello.txt",
          score: 100,
          kind: "file",
        },
      ],
    };

    mockInvoke.mockResolvedValue(mockResponse);

    const result = await fuzzySearch("hello", "/test", 10);

    expect(mockInvoke).toHaveBeenCalledWith("fuzzy_search", {
      query: "hello",
      root: "/test",
      limit: 10,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(1);
      expect(result.data[0].name).toBe("hello.txt");
    }
  });

  it("returns empty results when no matches", async () => {
    mockInvoke.mockResolvedValue({ results: [] });

    const result = await fuzzySearch("zzzznotfound", "/test", 10);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(0);
    }
  });
});
