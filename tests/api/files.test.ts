/**
 * Tests for API client - file operations.
 * Issue: tauri-explorer-4v1
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchDirectory } from "$lib/api/files";

describe("fetchDirectory", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
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

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const result = await fetchDirectory("/test");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.path).toBe("/test");
      expect(result.data.entries).toHaveLength(1);
      expect(result.data.entries[0].name).toBe("file.txt");
    }
  });

  it("returns error on HTTP 404", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ detail: "Directory not found" }),
    });

    const result = await fetchDirectory("/missing");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("Directory not found");
    }
  });

  it("returns error on HTTP 403", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ detail: "Permission denied" }),
    });

    const result = await fetchDirectory("/restricted");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("Permission denied");
    }
  });

  it("handles network errors", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    const result = await fetchDirectory("/test");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Network error");
    }
  });

  it("handles JSON parse errors gracefully", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error("Invalid JSON")),
    });

    const result = await fetchDirectory("/test");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("500");
    }
  });

  it("encodes path parameter correctly", async () => {
    const mockResponse = { path: "/test path", entries: [] };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    await fetchDirectory("/test path");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining(encodeURIComponent("/test path"))
    );
  });
});
