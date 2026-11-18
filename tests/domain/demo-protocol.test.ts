import { describe, expect, it } from "vitest";
import {
  appMessage,
  buildCustomThemeCss,
  customThemeId,
  demoOpenKind,
  parseCustomTheme,
  parseHostMessage,
} from "$lib/domain/demo-protocol";

const envelope = { tx: "tauri-explorer", v: 1 };

describe("parseHostMessage", () => {
  it("accepts a v1 init and keeps only well-typed fields", () => {
    const parsed = parseHostMessage({
      ...envelope, type: "init", fixture: { tree: {} }, assetBase: "http://x/", user: "ines",
      settings: { showSidebar: false }, keybindings: { a: "Ctrl+A", b: null, c: 4 }, startPath: "relative",
    });
    expect(parsed).toEqual({
      type: "init",
      init: { fixture: { tree: {} }, assetBase: "http://x/", user: "ines", settings: { showSidebar: false }, keybindings: { a: "Ctrl+A", b: null } },
    });
  });

  it("accepts requests with string or numeric ids and defaults params", () => {
    expect(parseHostMessage({ ...envelope, type: "request", id: 3, method: "getState" }))
      .toEqual({ type: "request", id: 3, method: "getState", params: [] });
    expect(parseHostMessage({ ...envelope, type: "request", id: "x", method: "run", params: ["view.list"] }))
      .toMatchObject({ params: ["view.list"] });
  });

  it.each([
    null, "init", [], { type: "init" }, { ...envelope, v: 2, type: "init" },
    { tx: "other", v: 1, type: "init" }, { ...envelope, type: "request", method: "x" },
    { ...envelope, type: "request", id: {}, method: "x" }, { ...envelope, type: "event" },
  ])("ignores %j", (data) => {
    expect(parseHostMessage(data)).toBeNull();
  });

  it("stamps app messages with the protocol", () => {
    expect(appMessage("event", { event: "ready" })).toEqual({ ...envelope, type: "event", event: "ready" });
  });
});

describe("custom themes", () => {
  const valid = { name: "Harbour Dusk", dark: true, v: ["#16202a", "#1f2c38", "#e6edf3", "#93a4b5", "#f2a65a", "#7fb3d5"] };

  it("validates the six colours", () => {
    expect(parseCustomTheme(valid)).toEqual(valid);
    expect(parseCustomTheme({ ...valid, v: valid.v.slice(0, 5) })).toBeNull();
    expect(parseCustomTheme({ ...valid, v: [...valid.v.slice(0, 5), "red"] })).toBeNull();
    expect(parseCustomTheme({ v: valid.v })).toMatchObject({ name: "Custom", dark: false });
  });

  it("keeps a hostile name from escaping the stylesheet", () => {
    const theme = parseCustomTheme({ ...valid, name: `x"; } body { display:none; } /*` })!;
    const css = buildCustomThemeCss(customThemeId(theme.name), theme)!;
    expect(theme.name).not.toMatch(/["{};]/);
    expect(css).not.toContain("display:none; }");
    expect(customThemeId("../../Évil Theme!")).toBe("site-vil-theme");
    expect(customThemeId("!!!")).toBe("site-custom");
  });

  it("builds a complete theme whose named tokens are the host's colours", () => {
    const theme = parseCustomTheme(valid)!;
    const css = buildCustomThemeCss("site-harbour-dusk", theme)!;
    expect(css).toContain('--theme-name: "Harbour Dusk"');
    const overrides = css.slice(css.lastIndexOf('[data-theme="site-harbour-dusk"]'));
    expect(overrides).toContain("--background-solid: #16202a");
    expect(overrides).toContain("--accent: #f2a65a");
    expect(overrides).toContain("--icon-folder: #7fb3d5");
    expect(overrides).toContain("color-scheme: dark");
  });
});

describe("demoOpenKind", () => {
  it.each([
    ["notes.md", { text: "# x", media: undefined }, "markdown"],
    ["counts.csv", { text: "a,b", media: undefined }, "csv"],
    ["log.txt", { text: "x", media: undefined }, "text"],
    ["call.flac", { text: null, media: undefined }, "audio"],
    ["permit.pdf", { text: null, media: undefined }, "pdf"],
    ["photo.CR3", { text: null, media: undefined }, "binary"],
    ["film", { text: null, media: { kind: "video" as const, src: null, poster: null, duration: null, pixels: null } }, "video"],
    ["track", { text: null, media: undefined, typeHint: "audio" }, "audio"],
  ])("%s → %s", (name, input, kind) => {
    expect(demoOpenKind(name, input)).toBe(kind);
  });
});
