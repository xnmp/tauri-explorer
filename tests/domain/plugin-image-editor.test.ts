/** A plugin may open the host image editor only in its own tools, for one absolute file. */
import { describe, expect, it } from "vitest";
import { imageEditorRequestError } from "$lib/domain/plugin-image-editor";

const own = new Set(["ai-edit"]);

describe("imageEditorRequestError", () => {
  it("accepts absolute POSIX, Windows drive and UNC paths in an owned tool", () => {
    for (const path of ["/home/user/a.png", "C:\\Users\\a.png", "d:/photos/a.png", "\\\\server\\share\\a.png"]) {
      expect(imageEditorRequestError({ path, tool: "ai-edit" }, own), path).toBeNull();
    }
  });

  it("refuses tools the caller did not register", () => {
    expect(imageEditorRequestError({ path: "/a.png", tool: "crop" }, own)).toMatch(/not registered/);
    expect(imageEditorRequestError({ path: "/a.png", tool: "other.ai-edit" }, own)).toMatch(/not registered/);
    expect(imageEditorRequestError({ path: "/a.png" }, own)).toMatch(/not registered/);
  });

  it("refuses relative, empty, NUL-bearing, oversized and non-string paths", () => {
    for (const path of ["a.png", "./a.png", "C:a.png", "", "/a\0.png", "/" + "a".repeat(4096), 42, null]) {
      expect(imageEditorRequestError({ path, tool: "ai-edit" }, own), String(path).slice(0, 20)).toMatch(/absolute file path/);
    }
  });

  it("refuses malformed requests", () => {
    for (const request of [null, undefined, "/a.png", 7]) {
      expect(imageEditorRequestError(request, own)).toMatch(/must be an object/);
    }
  });
});
