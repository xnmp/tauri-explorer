import { describe, expect, it } from "vitest";
import { getParentPath, parseBreadcrumbs } from "../../src/lib/state/navigation";

describe("parseBreadcrumbs", () => {
  it("returns empty array for empty input", () => {
    expect(parseBreadcrumbs("")).toEqual([]);
  });

  it("parses POSIX paths with leading slash as root", () => {
    expect(parseBreadcrumbs("/home/me/hello")).toEqual([
      { name: "home", path: "/home" },
      { name: "me", path: "/home/me" },
      { name: "hello", path: "/home/me/hello" },
    ]);
  });

  it("parses Windows backslash paths keeping drive letter as root", () => {
    expect(parseBreadcrumbs("C:\\Users\\me\\hello")).toEqual([
      { name: "C:", path: "C:\\" },
      { name: "Users", path: "C:\\Users" },
      { name: "me", path: "C:\\Users\\me" },
      { name: "hello", path: "C:\\Users\\me\\hello" },
    ]);
  });

  it("parses Windows forward-slash paths the same as backslash", () => {
    expect(parseBreadcrumbs("C:/Users/me/hello")).toEqual([
      { name: "C:", path: "C:\\" },
      { name: "Users", path: "C:\\Users" },
      { name: "me", path: "C:\\Users\\me" },
      { name: "hello", path: "C:\\Users\\me\\hello" },
    ]);
  });

  it("handles Windows drive root alone", () => {
    expect(parseBreadcrumbs("C:\\")).toEqual([{ name: "C:", path: "C:\\" }]);
  });

  it("parses UNC paths with server+share as the root breadcrumb", () => {
    expect(
      parseBreadcrumbs("\\\\wsl.localhost\\Ubuntu-24.04\\home\\chong")
    ).toEqual([
      { name: "\\\\wsl.localhost\\Ubuntu-24.04", path: "\\\\wsl.localhost\\Ubuntu-24.04" },
      { name: "home", path: "\\\\wsl.localhost\\Ubuntu-24.04\\home" },
      { name: "chong", path: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\chong" },
    ]);
  });

  it("handles UNC share root alone", () => {
    expect(parseBreadcrumbs("\\\\wsl.localhost\\Ubuntu-24.04")).toEqual([
      { name: "\\\\wsl.localhost\\Ubuntu-24.04", path: "\\\\wsl.localhost\\Ubuntu-24.04" },
    ]);
  });

  it("parses UNC paths written with forward slashes", () => {
    expect(parseBreadcrumbs("//wsl.localhost/Ubuntu-24.04/home")).toEqual([
      { name: "\\\\wsl.localhost\\Ubuntu-24.04", path: "\\\\wsl.localhost\\Ubuntu-24.04" },
      { name: "home", path: "\\\\wsl.localhost\\Ubuntu-24.04\\home" },
    ]);
  });
});

describe("getParentPath", () => {
  it("returns parent breadcrumb path for multi-segment paths", () => {
    const bc = parseBreadcrumbs("C:\\Users\\me\\hello");
    expect(getParentPath(bc)).toBe("C:\\Users\\me");
  });

  it("returns parent breadcrumb path for POSIX multi-segment paths", () => {
    const bc = parseBreadcrumbs("/home/me/hello");
    expect(getParentPath(bc)).toBe("/home/me");
  });

  it("returns POSIX root for single-segment POSIX paths", () => {
    expect(getParentPath(parseBreadcrumbs("/home"))).toBe("/");
  });

  it("returns null at Windows drive root (no parent)", () => {
    expect(getParentPath(parseBreadcrumbs("C:\\"))).toBeNull();
  });

  it("returns parent breadcrumb path for UNC paths", () => {
    const bc = parseBreadcrumbs("\\\\wsl.localhost\\Ubuntu-24.04\\home\\chong");
    expect(getParentPath(bc)).toBe("\\\\wsl.localhost\\Ubuntu-24.04\\home");
  });

  it("returns null at UNC share root (no parent above \\\\server\\share)", () => {
    expect(getParentPath(parseBreadcrumbs("\\\\wsl.localhost\\Ubuntu-24.04"))).toBeNull();
  });

  it("returns null for empty breadcrumbs", () => {
    expect(getParentPath([])).toBeNull();
  });
});
