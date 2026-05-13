import { describe, it, expect } from "vitest";
import { normalizePathInput, isDriveRoot, parentDir, basename } from "../../src/lib/domain/path";

describe("normalizePathInput", () => {
  it("appends a slash to a bare drive letter and uppercases it", () => {
    expect(normalizePathInput("e:")).toBe("E:/");
    expect(normalizePathInput("E:")).toBe("E:/");
  });

  it("trims surrounding whitespace before matching", () => {
    expect(normalizePathInput("  c:  ")).toBe("C:/");
  });

  it("leaves an already-rooted drive path unchanged", () => {
    expect(normalizePathInput("C:/")).toBe("C:/");
    expect(normalizePathInput("D:\\")).toBe("D:\\");
  });

  it("does not mangle regular unix paths", () => {
    expect(normalizePathInput("/home/user")).toBe("/home/user");
    expect(normalizePathInput("/")).toBe("/");
  });

  it("does not mangle relative paths or filenames", () => {
    expect(normalizePathInput("foo")).toBe("foo");
    expect(normalizePathInput("../bar")).toBe("../bar");
  });

  it("ignores multi-character 'drive letters' (not real drives)", () => {
    expect(normalizePathInput("ab:")).toBe("ab:");
  });
});

describe("isDriveRoot", () => {
  it("matches bare and separator-terminated drive letters", () => {
    expect(isDriveRoot("C:")).toBe(true);
    expect(isDriveRoot("C:/")).toBe(true);
    expect(isDriveRoot("C:\\")).toBe(true);
  });

  it("does not match subpaths of a drive", () => {
    expect(isDriveRoot("C:/Users")).toBe(false);
    expect(isDriveRoot("C:\\Users")).toBe(false);
  });

  it("does not match unix paths", () => {
    expect(isDriveRoot("/")).toBe(false);
    expect(isDriveRoot("/home")).toBe(false);
  });
});

describe("parentDir", () => {
  it("returns the parent of a nested path", () => {
    expect(parentDir("/home/user/file.txt")).toBe("/home/user");
    expect(parentDir("/home/user")).toBe("/home");
  });

  it("returns root for a top-level path", () => {
    expect(parentDir("/file.txt")).toBe("/");
    expect(parentDir("/home")).toBe("/");
  });

  it("returns root when there is no slash", () => {
    expect(parentDir("file.txt")).toBe("/");
  });

  it("returns root for root itself", () => {
    expect(parentDir("/")).toBe("/");
  });

  it("handles deeply nested paths", () => {
    expect(parentDir("/a/b/c/d/e")).toBe("/a/b/c/d");
  });
});

describe("basename", () => {
  it("returns the filename from a path", () => {
    expect(basename("/home/user/file.txt")).toBe("file.txt");
    expect(basename("/home/user")).toBe("user");
  });

  it("returns the input when there is no slash", () => {
    expect(basename("file.txt")).toBe("file.txt");
  });

  it("strips a trailing slash before extracting", () => {
    expect(basename("/home/user/")).toBe("user");
  });

  it("returns root for the root path", () => {
    expect(basename("/")).toBe("/");
  });

  it("handles deeply nested paths", () => {
    expect(basename("/a/b/c/d/e.rs")).toBe("e.rs");
  });

  it("handles dotfiles", () => {
    expect(basename("/home/user/.gitignore")).toBe(".gitignore");
  });

  it("handles empty string", () => {
    expect(basename("")).toBe("");
  });
});
