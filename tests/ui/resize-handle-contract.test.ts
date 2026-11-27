/**
 * One resize handle (#1925). Five panels used to carry their own separator
 * markup and `.resize-handle` CSS, each sized and coloured differently, so a
 * layout could not restyle them as a group. Every panel handle now renders
 * `ResizeHandle.svelte`, and split dividers draw the same line from the same
 * `--resize-*` variables, with the defaults docs/layout-themes.md publishes.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resizeOrientation } from "$lib/domain/resize-edge";

const COMPONENTS = "src/lib/components";
const read = (path: string) => readFileSync(path, "utf8");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "");

/** Panels resized through a ResizeController (use-resize-owner). */
const PANEL_HOSTS = [
  "Sidebar.svelte",
  "ScmPanel.svelte",
  "MillerColumns.svelte",
  "PreviewPane.svelte",
  "TerminalPanel.svelte",
  "PluginInspector.svelte",
];

describe("resize edge orientation", () => {
  it("maps a side edge to a vertical separator and a top/bottom edge to a horizontal one", () => {
    expect(resizeOrientation("left")).toBe("vertical");
    expect(resizeOrientation("right")).toBe("vertical");
    expect(resizeOrientation("top")).toBe("horizontal");
    expect(resizeOrientation("bottom")).toBe("horizontal");
  });
});

describe("every panel handle is the shared ResizeHandle", () => {
  it.each(PANEL_HOSTS)("%s renders ResizeHandle and no separator of its own", (file) => {
    const src = stripComments(read(join(COMPONENTS, file)));
    expect(src).toMatch(/import ResizeHandle from "\.\/ResizeHandle\.svelte"/);
    expect(src).toMatch(/<ResizeHandle\b[^>]*\bedge=/);
    expect(src).not.toMatch(/\srole="separator"/);
  });

  it("no other component styles a private .resize-handle", () => {
    const offenders = readdirSync(COMPONENTS, { recursive: true, encoding: "utf8" })
      .filter(file => file.endsWith(".svelte") && !file.endsWith("ResizeHandle.svelte"))
      .filter(file => /(^|[\s,{}>])\.resize-handle\b/m.test(stripComments(read(join(COMPONENTS, file)))));
    expect(offenders).toEqual([]);
  });

  it("the old per-panel component is gone", () => {
    expect(readdirSync(COMPONENTS)).not.toContain("PanelResizeHandle.svelte");
  });
});

/** The defaults docs/layout-themes.md publishes (#1925). */
const DEFAULTS: Record<string, string> = {
  "--resize-hit": "10px",
  "--resize-line-width": "1px",
  "--resize-active-width": "3px",
  "--resize-hover-delay": "250ms",
  "--resize-line": "var(--layout-hairline, var(--divider))",
  "--resize-active": "var(--accent)",
};

describe("--resize-* defaults", () => {
  const handle = read(join(COMPONENTS, "ResizeHandle.svelte"));
  const divider = read(join(COMPONENTS, "PaneLayoutView.svelte"));
  const fallbacks = (src: string, token: string) =>
    [...src.matchAll(new RegExp(`var\\(${token}, ((?:[^()]|\\((?:[^()]|\\([^()]*\\))*\\))+)\\)`, "g"))].map(m => m[1].trim());

  it.each(Object.entries(DEFAULTS))("%s falls back to %s in the handle and the divider", (token, value) => {
    for (const src of [handle, divider]) {
      const found = fallbacks(src, token);
      expect(found.length).toBeGreaterThan(0);
      expect(new Set(found)).toEqual(new Set([value]));
    }
  });
});
