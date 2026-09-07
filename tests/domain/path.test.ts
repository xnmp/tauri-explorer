import { describe, it, expect } from "vitest";
import {
  normalizePathInput,
  isDriveRoot,
  parentDir,
  basename,
  joinPath,
  isInsideDir,
  samePath,
  sameDirectory,
  toForwardSlashes,
  toBackslashes,
  toNativeSeparators,
  directoryKey,
  splitFlattenedUriList,
} from "../../src/lib/domain/path";

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

  it("handles Windows backslash paths", () => {
    expect(parentDir("C:\\Users\\foo")).toBe("C:/Users");
    expect(parentDir("C:\\Users")).toBe("C:/");
  });

  it("handles Windows forward-slash drive paths", () => {
    expect(parentDir("C:/Users/foo")).toBe("C:/Users");
    expect(parentDir("C:/Users")).toBe("C:/");
  });

  it("returns the drive root as its own parent (never bare 'C:')", () => {
    expect(parentDir("C:/")).toBe("C:/");
    expect(parentDir("C:\\")).toBe("C:/");
    expect(parentDir("C:")).toBe("C:/");
  });

  it("handles UNC paths", () => {
    expect(parentDir("\\\\server\\share\\dir\\file")).toBe("//server/share/dir");
    expect(parentDir("\\\\server\\share\\dir")).toBe("//server/share");
    // A share root is its own parent (can't go above the share)
    expect(parentDir("\\\\server\\share")).toBe("//server/share");
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

  it("handles Windows backslash paths", () => {
    expect(basename("C:\\Users\\foo")).toBe("foo");
    expect(basename("C:\\Users\\foo.txt")).toBe("foo.txt");
    expect(basename("\\\\server\\share\\file.txt")).toBe("file.txt");
  });

  it("handles mixed separators", () => {
    expect(basename("C:\\Users/foo - Link")).toBe("foo - Link");
  });
});

describe("joinPath", () => {
  it("joins with a forward slash", () => {
    expect(joinPath("/home/user", "file.txt")).toBe("/home/user/file.txt");
    expect(joinPath("/", "file.txt")).toBe("/file.txt");
  });

  it("does not double a trailing separator of either kind", () => {
    expect(joinPath("/home/", "file.txt")).toBe("/home/file.txt");
    expect(joinPath("C:\\Users\\", "file.txt")).toBe("C:\\Users\\file.txt");
  });

  it("matches the separator style the dir already uses (no mixed slashes)", () => {
    // A backslash-only dir stays all-backslash instead of going mixed.
    expect(joinPath("C:\\Users", "file.txt")).toBe("C:\\Users\\file.txt");
    // A path that already mixes (or is forward-slash) defaults to forward slash.
    expect(joinPath("C:/Users", "file.txt")).toBe("C:/Users/file.txt");
    expect(joinPath("C:\\Users/foo", "file.txt")).toBe("C:\\Users/foo/file.txt");
  });
});

describe("isInsideDir", () => {
  it("matches nested unix paths", () => {
    expect(isInsideDir("/a/b/c", "/a/b")).toBe(true);
    expect(isInsideDir("/a/b", "/a/b")).toBe(true);
  });

  it("matches nested windows paths regardless of separator", () => {
    expect(isInsideDir("C:\\a\\b\\c", "C:\\a")).toBe(true);
    expect(isInsideDir("C:/a/b", "C:\\a")).toBe(true);
  });

  it("rejects sibling paths that merely share a string prefix", () => {
    expect(isInsideDir("/a/bc", "/a/b")).toBe(false);
    expect(isInsideDir("C:\\abc", "C:\\a")).toBe(false);
  });

  it("tolerates a trailing separator on the parent", () => {
    expect(isInsideDir("/a/b/c", "/a/b/")).toBe(true);
  });
});

describe("samePath", () => {
  it("treats forward- and back-slash forms of the same path as equal", () => {
    expect(samePath("C:/Users/x", "C:\\Users\\x")).toBe(true);
    expect(samePath("C:\\Users\\x\\Documents", "C:/Users/x/Documents")).toBe(true);
  });

  it("ignores a single trailing separator", () => {
    expect(samePath("/a/b/", "/a/b")).toBe(true);
    expect(samePath("C:\\a\\", "C:/a")).toBe(true);
  });

  it("distinguishes genuinely different paths", () => {
    expect(samePath("/a/b", "/a/c")).toBe(false);
    expect(samePath("C:\\Users\\x", "C:\\Users\\y")).toBe(false);
  });

  it("matches parentDir output against a native backslash dir (the Windows drop bug)", () => {
    // parentDir emits forward slashes; the DOM data-path is backslash.
    expect(samePath(parentDir("C:\\Users\\x\\file.txt"), "C:\\Users\\x")).toBe(true);
  });
});

describe("toBackslashes", () => {
  it("converts forward slashes", () => {
    expect(toBackslashes("C:/Users/foo")).toBe("C:\\Users\\foo");
    expect(toBackslashes("C:\\Users\\foo")).toBe("C:\\Users\\foo");
  });
});

describe("toNativeSeparators", () => {
  it("coerces mixed separators to a single style", () => {
    expect(toNativeSeparators("C:\\Users/foo\\bar", "\\")).toBe("C:\\Users\\foo\\bar");
    expect(toNativeSeparators("C:\\Users/foo\\bar", "/")).toBe("C:/Users/foo/bar");
  });

  it("is a no-op when already in the target style", () => {
    expect(toNativeSeparators("/home/user", "/")).toBe("/home/user");
    expect(toNativeSeparators("C:\\Users\\foo", "\\")).toBe("C:\\Users\\foo");
  });
});

describe("directoryKey", () => {
  it("collapses separator variants to one key (the Ctrl+P duplicate bug)", () => {
    const a = directoryKey("C:\\Users\\chonw\\Pictures");
    expect(directoryKey("C:\\Users\\chonw/Pictures")).toBe(a); // mixed
    expect(directoryKey("C:/Users/chonw/Pictures")).toBe(a);   // forward
    expect(directoryKey("C:\\Users\\chonw\\Pictures\\")).toBe(a); // trailing
  });

  it("case-folds Windows-style paths (case-insensitive filesystem)", () => {
    expect(directoryKey("c:\\users\\x")).toBe(directoryKey("C:\\Users\\X"));
    expect(directoryKey("\\\\Server\\Share\\Dir")).toBe(directoryKey("//server/share/dir"));
  });

  it("does NOT case-fold or backslash-convert Unix paths", () => {
    // Unix is case-sensitive and backslash is a legal filename character.
    expect(directoryKey("/home/User")).not.toBe(directoryKey("/home/user"));
    expect(directoryKey("/home/a\\b")).toBe("/home/a/b");
  });

  it("distinguishes genuinely different directories", () => {
    expect(directoryKey("C:\\Users\\x")).not.toBe(directoryKey("C:\\Users\\y"));
  });
});

describe("toForwardSlashes", () => {
  it("converts backslashes", () => {
    expect(toForwardSlashes("C:\\Users\\foo")).toBe("C:/Users/foo");
    expect(toForwardSlashes("/already/posix")).toBe("/already/posix");
  });
});

describe("sameDirectory", () => {
  it("matches identical posix paths", () => {
    expect(sameDirectory("/home/user", "/home/user")).toBe(true);
    expect(sameDirectory("/home/user", "/home/other")).toBe(false);
  });

  it("ignores a trailing slash", () => {
    expect(sameDirectory("/home/user/", "/home/user")).toBe(true);
  });

  it("treats Windows separators as equivalent", () => {
    expect(sameDirectory("C:\\Users\\foo", "C:/Users/foo")).toBe(true);
  });

  it("is case-insensitive for Windows paths only", () => {
    expect(sameDirectory("C:/Users/Foo", "c:/users/foo")).toBe(true);
    expect(sameDirectory("//Server/Share/x", "//server/share/x")).toBe(true);
    // POSIX stays case-sensitive
    expect(sameDirectory("/home/Foo", "/home/foo")).toBe(false);
  });

  it("distinguishes genuinely different Windows dirs", () => {
    expect(sameDirectory("C:/Users/foo", "C:/Users/bar")).toBe(false);
  });
});

describe("hostile filenames (#198)", () => {
  const hostile = [
    "single'quote.txt",
    'double"quote.txt',
    "emoji-🍌🚀.txt",
    "url-hostile-#%&+=@!.txt",
    "with spaces  double.txt",
    "newline\nname.txt",
  ];

  it("basename returns adversarial names verbatim", () => {
    for (const name of hostile) {
      expect(basename(`/home/user/${name}`)).toBe(name);
    }
  });

  it("parentDir is unaffected by adversarial leaf names", () => {
    for (const name of hostile) {
      expect(parentDir(`/home/user/${name}`)).toBe("/home/user");
    }
  });

  it("a # or % in the leaf never truncates the path (URL-decode bugs)", () => {
    expect(basename("/data/100%.txt")).toBe("100%.txt");
    expect(basename("/data/issue#42.txt")).toBe("issue#42.txt");
    expect(parentDir("/data/issue#42.txt")).toBe("/data");
  });
});

describe("splitFlattenedUriList (#253)", () => {
  it("passes a normal single path through unchanged", () => {
    expect(splitFlattenedUriList("/home/u/file.png")).toEqual(["/home/u/file.png"]);
  });

  it("splits a WebKitGTK-flattened multi-file uri-list", () => {
    // wry strips file:// from the first entry only; separators are gone.
    const blob =
      "/home/u/a.pngfile:///home/u/b with space.jpgfile:///home/u/c.png";
    expect(splitFlattenedUriList(blob)).toEqual([
      "/home/u/a.png",
      "/home/u/b with space.jpg",
      "/home/u/c.png",
    ]);
  });

  it("handles a blob that still carries a leading scheme", () => {
    expect(splitFlattenedUriList("file:///home/u/a.pngfile:///home/u/b.png")).toEqual([
      "/home/u/a.png",
      "/home/u/b.png",
    ]);
  });

  it("returns empty input as-is", () => {
    expect(splitFlattenedUriList("")).toEqual([""]);
  });
});

it("preserves the case-sensitive Linux suffix of WSL directory identities", () => {
  expect(directoryKey("\\\\wsl.localhost\\Ubuntu\\home\\User")).not.toBe(directoryKey("\\\\wsl.localhost\\Ubuntu\\home\\user"));
  expect(directoryKey("\\\\WSL.LOCALHOST\\Ubuntu\\home\\User\\")).toBe(directoryKey("//wsl.localhost/Ubuntu/home/User"));
  expect(directoryKey("//wsl$/Ubuntu/home/User")).not.toBe(directoryKey("//wsl$/Ubuntu/home/user"));
});
