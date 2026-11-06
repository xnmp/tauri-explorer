import { describe, expect, it } from "vitest";
import { normalizeDetailColumns, normalizeDetailRowValues, normalizeFileIcon } from "$lib/domain/plugin-contribution-validation";
import { MAX_ICON_SVG_BYTES } from "$lib/domain/plugin-file-icon";

const SVG = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><rect width='16' height='16' fill='#c00'/></svg>";
const decode = (src: string) => decodeURIComponent(src.replace(/^data:image\/svg\+xml;charset=utf-8,/, ""));

describe("normalizeFileIcon (#1523)", () => {
  it("normalizes extensions to lowercase without dots and renders a data URI", () => {
    const { extensions, icon } = normalizeFileIcon({ id: "p.rep", extensions: [".REP", "rep", " Replay "], svg: SVG, typeName: "StarCraft replay" });
    expect(extensions).toEqual(["rep", "replay"]);
    expect(icon.src.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    expect(decode(icon.src)).toBe(SVG);
    expect(icon.typeName).toBe("StarCraft replay");
  });

  it("adds the SVG namespace an <img> requires", () => {
    const { icon } = normalizeFileIcon({ id: "p.x", extensions: ["x"], svg: "<svg viewBox='0 0 1 1'></svg>" });
    expect(decode(icon.src)).toBe(`<svg xmlns="http://www.w3.org/2000/svg" viewBox='0 0 1 1'></svg>`);
  });

  it.each([
    [{ extensions: [] }, /1-32 extensions/],
    [{ extensions: "rep" }, /1-32 extensions/],
    [{ extensions: Array.from({ length: 33 }, (_, i) => `e${i}`) }, /1-32 extensions/],
    [{ extensions: [""] }, /invalid extension/],
    [{ extensions: ["a/b"] }, /invalid extension/],
    [{ extensions: [42] }, /invalid extension/],
    [{ svg: "<div>no</div>" }, /must be <svg>/],
    [{ svg: "<svg></svg><script>x</script>" }, /must be <svg>/],
    [{ svg: null }, /must be <svg>/],
    [{ svg: `<svg>${"x".repeat(MAX_ICON_SVG_BYTES)}</svg>` }, /exceeds/],
  ])("rejects %j", (patch, message) => {
    expect(() => normalizeFileIcon({ id: "p.bad", extensions: ["rep"], svg: SVG, ...patch } as never)).toThrow(message);
  });

  it("drops control characters and bounds the type name; omits an empty one", () => {
    expect(normalizeFileIcon({ id: "p.x", extensions: ["x"], svg: SVG, typeName: `a\u0000b${"c".repeat(100)}` }).icon.typeName).toBe(`ab${"c".repeat(62)}`);
    expect(normalizeFileIcon({ id: "p.x", extensions: ["x"], svg: SVG, typeName: " \n " }).icon).not.toHaveProperty("typeName");
  });
});

describe("normalizeDetailColumns (#1523)", () => {
  it("qualifies ids, clamps widths and defaults to 120", () => {
    expect(normalizeDetailColumns("p.cols", [
      { key: "matchup", label: "Matchup", width: 90 },
      { key: "map", label: " Map ", width: 10 },
      { key: "players", label: "Players", width: Number.NaN },
      { key: "wide", label: "Wide", width: 1e9 },
    ])).toEqual([
      { id: "p.cols:matchup", key: "matchup", label: "Matchup", width: 90 },
      { id: "p.cols:map", key: "map", label: "Map", width: 60 },
      { id: "p.cols:players", key: "players", label: "Players", width: 120 },
      { id: "p.cols:wide", key: "wide", label: "Wide", width: 4096 },
    ]);
  });

  it.each([
    [[], /1-8 columns/],
    [null, /1-8 columns/],
    [Array.from({ length: 9 }, (_, i) => ({ key: `k${i}`, label: "L" })), /1-8 columns/],
    [[{ key: "Bad", label: "L" }], /invalid or repeated key/],
    [[{ key: "a", label: "A" }, { key: "a", label: "B" }], /invalid or repeated key/],
    [[{ key: "a", label: "" }], /needs a label/],
    [[null], /invalid or repeated key/],
  ])("rejects %j", (specs, message) => {
    expect(() => normalizeDetailColumns("p.cols", specs)).toThrow(message);
  });
});

describe("normalizeDetailRowValues (#1523)", () => {
  const keys = ["matchup", "map"];
  it("keeps declared keys with text and a valid length", () => {
    expect(normalizeDetailRowValues({ columns: { matchup: "PvZ", map: "Fighting\tSpirit", extra: "x" }, lengthSeconds: 734.5 }, keys))
      .toEqual({ columns: { matchup: "PvZ", map: "Fighting Spirit" }, lengthSeconds: 734.5 });
  });

  it.each([null, undefined, 3, "PvZ"])("treats %j as unreadable", (value) => {
    expect(normalizeDetailRowValues(value, keys)).toBeNull();
  });

  it("drops non-string values, empty text, invalid lengths and inherited keys", () => {
    const inherited = Object.create({ matchup: "proto" });
    expect(normalizeDetailRowValues({ columns: { matchup: 3, map: "  " }, lengthSeconds: -1 }, keys)).toEqual({ columns: {} });
    expect(normalizeDetailRowValues({ columns: inherited, lengthSeconds: Number.POSITIVE_INFINITY }, keys)).toEqual({ columns: {} });
  });

  it("neutralizes bidirectional overrides that could spoof surrounding text", () => {
    expect(normalizeDetailRowValues({ columns: { map: "evil\u202Eexe.rep" } }, keys)?.columns?.map).toBe("evil exe.rep");
    expect(normalizeFileIcon({ id: "p.x", extensions: ["x"], svg: SVG, typeName: "Re\u2066play\u2069" }).icon.typeName).toBe("Replay");
  });

  it("bounds extremely long text", () => {
    expect(normalizeDetailRowValues({ columns: { map: "m".repeat(10_000) } }, keys)?.columns?.map).toHaveLength(512);
  });
});
