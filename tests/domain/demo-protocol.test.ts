import { describe, expect, it } from "vitest";
import {
  appMessage,
  buildCustomThemeCss,
  CUSTOM_PANEL_MIN_ALPHA,
  customThemeId,
  demoOpenKind,
  parseCustomTheme,
  panelLayerOver,
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

describe("panelLayerOver (#1789)", () => {
  const parse = (rgba: string) => rgba.match(/[\d.]+/g)!.map(Number);
  const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const over = (layer: number[], paper: number[]) => layer.slice(0, 3).map((c, i) => c * layer[3] + paper[i] * (1 - layer[3]));

  it.each([
    ["#1a1b26", "#24283b"], // Tokyo Night: panel lighter than paper
    ["#1f1f28", "#17171e"], // Kanagawa: panel darker than paper
    ["#f4dccf", "#e8c7b6"], // Peach Alloy, light
    ["#000000", "#ffffff"], // extremes
    ["#ffffff", "#000000"],
    ["#336699", "#336699"], // panel equals paper
    ["#abc", "#123"], // short hex
  ])("is translucent and shows exactly the panel over paper %s / %s", (paper, panel) => {
    const full = (h: string) => (h.length === 4 ? "#" + [...h.slice(1)].map((c) => c + c).join("") : h);
    const layer = parse(panelLayerOver(paper, panel));
    expect(layer[3]).toBeGreaterThanOrEqual(CUSTOM_PANEL_MIN_ALPHA);
    expect(layer[3]).toBeLessThanOrEqual(1);
    layer.slice(0, 3).forEach((c) => expect(c).toBeGreaterThanOrEqual(0));
    layer.slice(0, 3).forEach((c) => expect(c).toBeLessThanOrEqual(255));
    over(layer, hex(full(paper))).forEach((c, i) => expect(c).toBeCloseTo(hex(full(panel))[i], 0));
  });

  it("keeps the alpha at its floor when the panel allows it, and clamps a bad floor", () => {
    expect(parse(panelLayerOver("#1a1b26", "#24283b"))[3]).toBe(CUSTOM_PANEL_MIN_ALPHA);
    expect(parse(panelLayerOver("#1a1b26", "#24283b", 7))[3]).toBe(1);
    expect(parse(panelLayerOver("#1a1b26", "#24283b", -1))[3]).toBeGreaterThan(0);
  });

  it("gives custom themes translucent cards, so the window material can show", () => {
    const css = buildCustomThemeCss("site-harbour-dusk", parseCustomTheme({ name: "Harbour Dusk", dark: true, v: ["#16202a", "#1f2c38", "#e6edf3", "#93a4b5", "#f2a65a", "#7fb3d5"] })!)!;
    const overrides = css.slice(css.lastIndexOf('[data-theme="site-harbour-dusk"]'));
    expect(overrides).toMatch(/--background-card: rgba\([^)]*, 0\.5\)/);
    expect(overrides).not.toContain("--background-card: #1f2c38");
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
