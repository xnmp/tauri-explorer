/**
 * Virtual (plugin-provided) path helpers (src/lib/domain/virtual-path.ts).
 */

import { describe, it, expect } from "vitest";
import {
  isVirtualPath,
  isVirtualRoot,
  parseVirtualPath,
  virtualScheme,
  virtualBreadcrumbs,
} from "$lib/domain/virtual-path";
import { toNativeSeparators } from "$lib/domain/path";

describe("isVirtualPath", () => {
  it("recognizes scheme:// paths with a ≥2-char scheme", () => {
    expect(isVirtualPath("demo://")).toBe(true);
    expect(isVirtualPath("demo://a/b")).toBe(true);
    expect(isVirtualPath("keep://note/123")).toBe(true);
  });

  it("does not treat Windows drive letters as virtual", () => {
    expect(isVirtualPath("C://Users")).toBe(false); // single-char scheme
    expect(isVirtualPath("C:/Users")).toBe(false);
    expect(isVirtualPath("C:\\Users")).toBe(false);
  });

  it("rejects real paths and malformed input", () => {
    expect(isVirtualPath("/home/user")).toBe(false);
    expect(isVirtualPath("")).toBe(false);
    expect(isVirtualPath("demo:/single-slash")).toBe(false);
    expect(isVirtualPath("://noscheme")).toBe(false);
    expect(isVirtualPath("not a path")).toBe(false);
  });

  it("is case-insensitive on the scheme", () => {
    expect(isVirtualPath("Demo://x")).toBe(true);
    expect(virtualScheme("DEMO://x")).toBe("demo");
  });
});

describe("isVirtualRoot", () => {
  it("matches only the bare scheme root", () => {
    expect(isVirtualRoot("demo://")).toBe(true);
    expect(isVirtualRoot("demo://a")).toBe(false);
    expect(isVirtualRoot("/home")).toBe(false);
  });
});

describe("parseVirtualPath", () => {
  it("splits scheme and remainder", () => {
    expect(parseVirtualPath("demo://a/b")).toEqual({ scheme: "demo", rest: "a/b" });
    expect(parseVirtualPath("demo://")).toEqual({ scheme: "demo", rest: "" });
  });

  it("returns null for non-virtual input", () => {
    expect(parseVirtualPath("/home/user")).toBeNull();
    expect(parseVirtualPath("C:/Users")).toBeNull();
    expect(parseVirtualPath("")).toBeNull();
  });
});

describe("virtualScheme", () => {
  it("returns the lowercased scheme or null", () => {
    expect(virtualScheme("demo://x")).toBe("demo");
    expect(virtualScheme("/real/path")).toBeNull();
  });
});

describe("virtualBreadcrumbs", () => {
  it("yields scheme-root then one crumb per segment", () => {
    expect(virtualBreadcrumbs("demo://a/b")).toEqual([
      { name: "demo://", path: "demo://" },
      { name: "a", path: "demo://a" },
      { name: "b", path: "demo://a/b" },
    ]);
  });

  it("yields just the root for a bare scheme", () => {
    expect(virtualBreadcrumbs("demo://")).toEqual([{ name: "demo://", path: "demo://" }]);
  });

  it("ignores repeated/trailing slashes", () => {
    expect(virtualBreadcrumbs("demo://a//b/")).toEqual([
      { name: "demo://", path: "demo://" },
      { name: "a", path: "demo://a" },
      { name: "b", path: "demo://a/b" },
    ]);
  });

  it("returns null for non-virtual paths", () => {
    expect(virtualBreadcrumbs("/home/user")).toBeNull();
  });
});

describe("toNativeSeparators bypass", () => {
  it("leaves virtual paths untouched even when targeting backslashes", () => {
    expect(toNativeSeparators("demo://a/b", "\\")).toBe("demo://a/b");
  });

  it("still normalizes real paths", () => {
    expect(toNativeSeparators("C:/Users/x", "\\")).toBe("C:\\Users\\x");
    expect(toNativeSeparators("C:\\Users\\x", "/")).toBe("C:/Users/x");
  });
});
