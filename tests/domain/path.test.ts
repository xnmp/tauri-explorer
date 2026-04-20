import { describe, it, expect } from "vitest";
import { normalizePathInput, isDriveRoot } from "../../src/lib/domain/path";

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
