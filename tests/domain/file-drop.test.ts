import { describe, expect, it } from "vitest";
import { domDropPaths, domOwnsFileDrop, internalDragPaths, sameDropPathSet, validatedDropPaths } from "$lib/domain/file-drop";

const data = (path: string, paths?: unknown) => ({ path, name: "a.png", kind: "file", ...(paths === undefined ? {} : { paths }) });
const transfer = (value: string, path = "/a.png") => ({ getData: (type: string) => type.endsWith("-paths") ? value : path });

describe("verified file drop paths", () => {
  it("preserves the complete ordered batch in a fresh array", () => {
    const paths = ["/z.png", "/a.png"];
    expect(internalDragPaths(data("/a.png", paths), false)).toEqual(paths);
    expect(validatedDropPaths(paths, false)).not.toBe(paths);
  });

  it.each([null, {}, [], [null], [1], ["/a.png", "relative.png"], ["file:///a.png"], ["blob:test"], ["demo://image"], ["/a\0.png"], ["/a/../b.png"]].map(value => [value]))("rejects malformed arrays and paths: %j", value => {
    expect(validatedDropPaths(value, false)).toBeNull();
    expect(internalDragPaths(data("/a.png", value), false)).toBeNull();
  });

  it.each([null, {}, { path: "/a.png", kind: "file" }, { ...data("/a.png"), kind: "virtual" }, data("relative.png"), data("/a.png", ["/b.png"])])("rejects malformed internal records: %j", value => {
    expect(internalDragPaths(value, false)).toBeNull();
  });

  it("rejects sparse arrays and malformed primary paths even with a valid multi-payload", () => {
    expect(validatedDropPaths(new Array(2), false)).toBeNull();
    expect(domDropPaths(transfer('["/a.png"]', "relative.png"), false)).toBeNull();
    expect(domDropPaths(transfer('["/a.png"]', "/unrelated.png"), false)).toBeNull();
  });

  it("keeps large ordered batches intact with linear full-set verification", () => {
    const batch = Array.from({ length: 20000 }, (_, index) => `/images/${index}.png`);
    expect(validatedDropPaths(batch, false)).toEqual(batch);
    expect(sameDropPathSet(batch, [...batch].reverse())).toBe(true);
  });

  it("compares Windows transport separator equivalents without changing source order", () => {
    expect(sameDropPathSet(["C:\\Images/a.png", "C:/Images/b.png"], ["C:\\Images\\b.png", "C:\\Images\\a.png"], true)).toBe(true);
  });

  it("validates Windows absolute and UNC paths", () => {
    expect(validatedDropPaths(["C:\\Images\\a.png", "\\\\server\\share\\b.png"], true)).toEqual(["C:\\Images\\a.png", "\\\\server\\share\\b.png"]);
    expect(validatedDropPaths(["C:a.png"], true)).toBeNull();
  });

  it("matches every member including multiplicity, independently of native order", () => {
    expect(sameDropPathSet(["/a", "/b"], ["/b", "/a"])).toBe(true);
    expect(sameDropPathSet(["/a"], ["/a", "/b"])).toBe(false);
    expect(sameDropPathSet(["/a", "/x"], ["/a", "/b"])).toBe(false);
    expect(sameDropPathSet(["/a", "/a"], ["/a", "/b"])).toBe(false);
  });

  it.each(["not json", "null", "{}", "[]", '["/a.png", 1]', '["relative.png"]'])("never falls back after a malformed multi-payload: %s", value => {
    expect(domDropPaths(transfer(value), false)).toBeNull();
  });

  it("reads internal MIME only, never File.name, File.path, URI or text", () => {
    expect(domDropPaths({ getData: () => "" }, false)).toBeNull();
    expect(domDropPaths(transfer('["/b.png","/a.png"]'), false)).toEqual(["/b.png", "/a.png"]);
  });

  it("chooses one transport: DOM until native handoff succeeds", () => {
    expect(domOwnsFileDrop(false)).toBe(true);
    expect(domOwnsFileDrop(true)).toBe(false);
  });
});

it.each([
  [1010, 1010, 1012, true], [1011.25, 1010, 1012, true],
  [1009.99, 1010, 1012, false], [1012, 1010, 1012, false], [1013, 1010, 1012, false],
  [NaN, 1010, 1012, false], [Infinity, 1010, 1012, false], [1011, NaN, 1012, false],
  [1011, 1010, NaN, false], [1011, 1010, undefined, true],
])("native observation %s belongs to HTML5 [%s, %s): %s", async (observed, start, end, expected) => {
  const { observedDuringGesture } = await import("$lib/domain/file-drop");
  expect(observedDuringGesture(observed, start, end)).toBe(expected);
});
