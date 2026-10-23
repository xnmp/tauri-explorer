import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classify,
  devServerScripts,
  selectChromium,
  selectViewModes,
  selectWebkit,
  svelteStyleChanged,
  unionSelections,
  viewModeSpecs,
  webkitSensitivity,
} from "../scripts/e2e-affected.mjs";

// An existing spec, so the "changed spec selects itself" rule can see it on disk.
const SPEC = "e2e/quickopen-debug.spec.ts";

const map = {
  hubs: ["routes/+page.svelte"],
  clusters: [
    { title: "Quick Open", files: ["components/QuickOpen.svelte"], phrases: new Set(["quick-open"]) },
    { title: "Orphan", files: ["components/Orphan.svelte"], phrases: new Set(["nothing-matches-this"]) },
  ],
};
const specs = [
  { rel: "e2e/quick-open.spec.ts", content: "test('quick-open finds files')" },
  { rel: "e2e/other.spec.ts", content: "test('unrelated')" },
  { rel: "e2e/cloud.spec.ts", content: 'readfilesync("tests/fixtures/sidebar-cloud-mounts.json")' },
];

const select = (changed: string[], devServerInputs = new Set<string>(), strict = false) => {
  const { all, selected } = classify(changed, map, specs, devServerInputs, { strict });
  return all ? "ALL" : [...selected].sort();
};

describe("classify", () => {
  it("ignores files the browser suite never executes", () => {
    expect(
      select([
        "src-tauri/src/files/move_session.rs",
        "src-tauri/Cargo.toml",
        "tests/state/window-tabs.test.ts",
        "evidence/ac-1-something.png",
        "docs/lessons/1-x.md",
        "README.md",
        "scripts/qualify-macos-startup.ts",
        "e2e-tauri/specs/x.spec.ts",
        "vitest.config.ts",
        "vitest.perf.config.ts",
        "packaging/tauri-explorer.portal",
        "e2e-load/tab-fanout.spec.ts",
        "playwright.load.config.ts",
        "e2e-sweep/perf-sweep.spec.ts",
        "playwright.sweep.config.ts",
        "PKGBUILD",
        "flake.nix",
        ".vscode/settings.json",
      ]),
    ).toEqual([]);
  });

  it("selects a changed spec and the specs of a changed source file's cluster", () => {
    expect(select([SPEC, "src/lib/components/QuickOpen.svelte"])).toEqual([SPEC, "e2e/quick-open.spec.ts"].sort());
  });

  it("selects a spec that reads a changed file from an otherwise ignored directory", () => {
    expect(select(["tests/fixtures/sidebar-cloud-mounts.json"])).toEqual(["e2e/cloud.spec.ts"]);
    expect(select(["tests/fixtures/sidebar-cloud-mounts.json"], new Set(), true)).toEqual(["e2e/cloud.spec.ts"]);
  });

  it("runs everything for any frontend source change in strict mode", () => {
    expect(select(["src/lib/components/QuickOpen.svelte"], new Set(), true)).toBe("ALL");
    expect(select(["src/lib/components/QuickOpen.svelte"])).toEqual(["e2e/quick-open.spec.ts"]);
  });

  it("narrows in strict mode when no frontend source changed", () => {
    expect(select([SPEC, "src-tauri/src/lib.rs", "tests/state/window-tabs.test.ts"], new Set(), true)).toEqual([SPEC]);
  });

  it("does not select a deleted spec", () => {
    expect(select(["e2e/deleted-long-ago.spec.ts"])).toEqual([]);
  });

  it.each([
    ["the mock backend", "src/lib/api/mock-invoke.ts"],
    ["a mock backend module", "src/lib/api/mock-fixtures.ts"],
    ["shared e2e helpers", "e2e/helpers.ts"],
    ["e2e fixtures", "e2e/fixtures.ts"],
    ["a central hub", "src/routes/+page.svelte"],
    ["an unmapped source file", "src/lib/domain/brand-new.ts"],
    ["a cluster that resolves to no spec", "src/lib/components/Orphan.svelte"],
    ["package.json", "package.json"],
    ["the lockfile", "bun.lock"],
    ["the Playwright config", "playwright.config.ts"],
    ["the Vite config", "vite.config.ts"],
    ["the CI workflow that selects specs", ".github/workflows/ci.yml"],
    ["the shard planner", "scripts/e2e-shards.mjs"],
    ["the spec selector", "scripts/e2e-affected.mjs"],
    ["the version-only classifier", "scripts/version-only.mjs"],
    ["the test-result cache config", "turbo.json"],
    ["the test-result cache wrapper", "scripts/test-cache.mjs"],
    ["the cached browser-shard runner", "scripts/ci-test-e2e.sh"],
    ["an unknown top-level file", "website/api/report.js"],
  ])("runs everything for %s", (_label, file) => {
    expect(select([SPEC, file])).toBe("ALL");
  });

  it("runs everything when a dev-server script changes", () => {
    expect(select(["scripts/prepare-pdf-assets.mjs"], new Set(["scripts/prepare-pdf-assets.mjs"]))).toBe("ALL");
    expect(select(["scripts/prepare-pdf-assets.mjs"])).toEqual([]);
  });

  it("selects nothing for an empty diff", () => {
    expect(select([])).toEqual([]);
  });
});

describe("devServerScripts", () => {
  it("collects scripts named by the dev-server configs, nested paths and their relative imports", () => {
    const root = mkdtempSync(join(tmpdir(), "e2e-affected-"));
    try {
      mkdirSync(join(root, "scripts/lib"), { recursive: true });
      writeFileSync(join(root, "vite.config.ts"), 'import { guard } from "./scripts/release-hook-leaks.mjs";');
      writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { dev: "node scripts/prepare-pdf-assets.mjs && vite dev" } }));
      writeFileSync(join(root, "playwright.config.ts"), 'command: "node scripts/lib/serve.mjs"');
      writeFileSync(join(root, "scripts/prepare-pdf-assets.mjs"), 'import { copy } from "./lib/copy.mjs";\nawait import("../outside.mjs");');

      expect([...devServerScripts(root)].sort()).toEqual([
        "scripts/lib/copy.mjs",
        "scripts/lib/serve.mjs",
        "scripts/prepare-pdf-assets.mjs",
        "scripts/release-hook-leaks.mjs",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("tolerates missing files", () => {
    const root = mkdtempSync(join(tmpdir(), "e2e-affected-"));
    try {
      expect([...devServerScripts(root)]).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("includes the repository's dev-server inputs", () => {
    expect(devServerScripts().has("scripts/prepare-pdf-assets.mjs")).toBe(true);
  });
});

describe("e2e-affected CLI", () => {
  const run = (...args: string[]) =>
    execFileSync("node", ["scripts/e2e-affected.mjs", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

  it("reports mode and reason as JSON for CI logs", () => {
    expect(JSON.parse(run("--strict", "--json", "--max-files", "50", "HEAD", "HEAD"))).toEqual({
      mode: "none",
      reason: "no changes for HEAD...HEAD",
      items: [],
    });
    expect(JSON.parse(run("--strict", "--json", "--max-files", "50", "no-such-ref-1175", "HEAD"))).toEqual({
      mode: "all",
      reason: "selection failed: git diff",
      items: [],
    });
  });

  it("keeps the plain ALL output for local runs", () => {
    expect(run("no-such-ref-1175", "HEAD")).toBe("ALL\n");
    expect(run("HEAD", "HEAD")).toBe("");
  });
});

describe("per-engine PR selections (#1367)", () => {
  const engineMap = {
    hubs: ["routes/+page.svelte"],
    clusters: [
      { title: "Quick Open", files: ["components/QuickOpen.svelte", "domain/quick-open-search.ts"], phrases: new Set(["quick-open"]) },
      { title: "Tiles", files: ["components/TilesView.svelte"], phrases: new Set(["tiles-view"]) },
      { title: "Settings", files: ["components/SettingsDialog.svelte"], phrases: new Set(["settings-dialog"]) },
      // Mapped, so only their WKWebView sensitivity can escalate them.
      {
        title: "Sensitive",
        files: ["app.css", "themes/index.ts", "domain/zoom.ts", "components/ContextMenu.svelte", "components/FileList.svelte",
          "components/FileItem.svelte", "domain/marquee-rect.ts", "components/HtmlPreview.svelte", "state/drag.svelte.ts",
          "domain/peek-membership.ts"],
        phrases: new Set(["settings-dialog"]),
      },
    ],
  };
  // Spec content is lowercased by loadSpecs.
  const engineSpecs = [
    { rel: "e2e/quick-open.spec.ts", content: "test('quick-open finds files')" },
    { rel: "e2e/tiles.spec.ts", content: "import { view_modes } from './helpers'; for (const m of view_modes) test('tiles-view ' + m)" },
    { rel: "e2e/engine.spec.ts", content: "test.skip(browsername === 'webkit', 'chromium only')" },
    { rel: "e2e/settings.spec.ts", content: "test('settings-dialog opens')" },
    { rel: "e2e/grid.spec.ts", content: "import { gridmodes } from './grid-modes'; test('grid')" },
  ];
  const support = [{ rel: "e2e/grid-modes.ts", content: "export const gridmodes = view_variants;" }];
  type Read = (side: "base" | "head", path: string) => string | null;
  const unchanged = (text: string): Read => () => text;
  const input = (changed: string[], read: Read = unchanged("<script>let a = 1;</script>")) =>
    ({ changed, map: engineMap, specs: engineSpecs, read, support });

  describe("selectChromium", () => {
    it("runs every spec for any frontend source change", () => {
      expect(selectChromium(input(["src/lib/components/QuickOpen.svelte"])).mode).toBe("all");
    });
    it("narrows a change that never ships in the frontend", () => {
      expect(selectChromium(input([SPEC, "src-tauri/src/lib.rs"]))).toMatchObject({ mode: "selected", items: [SPEC] });
    });
  });

  describe("selectWebkit", () => {
    it("runs cluster-mapped specs plus the curated engine-specific set for a script-only component change", () => {
      const read = (side: "base" | "head") => side === "base"
        ? "<script>let a = 1;</script>\n<div class=\"x\">{a}</div>\n<style>.x{color:red}</style>"
        : "<script>let a = 2;</script>\n<div class=\"x\">{a}</div>\n<style>.x{color:red}</style>";
      expect(selectWebkit(input(["src/lib/components/SettingsDialog.svelte"], read))).toEqual({
        mode: "selected",
        reason: "2 cluster-mapped or curated WebKit spec(s) from 1 changed file(s)",
        items: ["e2e/engine.spec.ts", "e2e/settings.spec.ts"],
      });
    });

    it("keeps the Chromium selection when that is already narrow", () => {
      expect(selectWebkit(input([SPEC]))).toMatchObject({ mode: "selected", items: [SPEC] });
      expect(selectWebkit(input(["src-tauri/src/lib.rs"])).mode).toBe("none");
    });

    it.each([
      ["a stylesheet", "src/app.css"],
      ["a theme module", "src/lib/themes/index.ts"],
      ["zoom geometry", "src/lib/domain/zoom.ts"],
      ["a fixed overlay", "src/lib/components/ContextMenu.svelte"],
      ["FileList", "src/lib/components/FileList.svelte"],
      ["FileItem", "src/lib/components/FileItem.svelte"],
      ["the marquee", "src/lib/domain/marquee-rect.ts"],
      ["a preview", "src/lib/components/HtmlPreview.svelte"],
      ["drag and drop", "src/lib/state/drag.svelte.ts"],
      ["a peek", "src/lib/domain/peek-membership.ts"],
    ])("runs every WebKit spec for %s", (_label, file) => {
      const result = selectWebkit(input([file]));
      expect(result.mode).toBe("all");
      expect(result.reason).toContain("WKWebView-sensitive");
    });

    it("runs every WebKit spec when a component's styling changes", () => {
      const styled = (css: string) => () => `<script>let a;</script>\n<style>${css}</style>`;
      let side = 0;
      const read = () => (side++ === 0 ? styled(".a{color:red}")() : styled(".a{color:blue}")());
      expect(selectWebkit(input(["src/lib/components/SettingsDialog.svelte"], read)).reason)
        .toBe("WKWebView-sensitive change (component styling): src/lib/components/SettingsDialog.svelte");
    });

    it.each([
      ["the mock backend", "src/lib/api/mock-invoke.ts"],
      ["shared e2e helpers", "e2e/helpers.ts"],
      ["a central hub", "src/routes/+page.svelte"],
      ["an unmapped source file", "src/lib/domain/brand-new.ts"],
      ["the Playwright config", "playwright.config.ts"],
      ["package.json", "package.json"],
      ["the lockfile", "bun.lock"],
      ["the CI workflow", ".github/workflows/ci.yml"],
    ])("still runs every WebKit spec for %s", (_label, file) => {
      expect(selectWebkit(input(["src/lib/components/SettingsDialog.svelte", file])).mode).toBe("all");
    });
  });

  describe("selectViewModes", () => {
    it("lists the specs that iterate the view modes, directly or through a support module", () => {
      expect(viewModeSpecs(engineSpecs, support)).toEqual(["e2e/grid.spec.ts", "e2e/tiles.spec.ts"]);
    });

    it("runs the view-mode specs a changed view-mode component reaches", () => {
      expect(selectViewModes(input(["src/lib/components/TilesView.svelte"]))).toMatchObject({
        mode: "selected", items: ["e2e/tiles.spec.ts"],
      });
    });

    it("runs a changed view-mode spec in every mode", () => {
      expect(selectViewModes(input(["e2e/grid.spec.ts"]))).toMatchObject({ mode: "selected", items: ["e2e/grid.spec.ts"] });
    });

    it("runs nothing extra for a component outside the view modes", () => {
      expect(selectViewModes(input(["src/lib/components/QuickOpen.svelte"])).mode).toBe("none");
      expect(selectViewModes(input(["src/lib/domain/brand-new.ts"])).mode).toBe("none");
    });

    it("runs every view-mode spec for an unmapped view-mode component", () => {
      expect(selectViewModes(input(["src/lib/components/NewTileThing.svelte"])).mode).toBe("all");
    });

    it.each([
      ["stylesheet", "src/lib/components/modal.css"],
      ["stylesheet", "src/lib/themes/nord.css"],
      ["theme", "src/lib/themes/index.ts"],
      ["global markup", "src/app.html"],
      ["global markup", "src/routes/+layout.ts"],
    ])("runs every view-mode spec for an app-wide %s change (%s)", (label, file) => {
      expect(selectViewModes(input([file]))).toMatchObject({
        mode: "all", reason: `app-wide presentation change (${label}): ${file}`,
      });
      // Even next to an otherwise narrow change.
      expect(selectViewModes(input(["src/lib/components/QuickOpen.svelte", file])).mode).toBe("all");
    });

    it("does not treat the website's stylesheets as app presentation", () => {
      expect(selectViewModes(input(["website/fixture-only.css"])).reason).not.toMatch(/app-wide presentation/);
    });

    it.each(["src/lib/api/mock-invoke.ts", "e2e/helpers.ts", "playwright.config.ts", "bun.lock", ".github/workflows/ci.yml"])(
      "runs every view-mode spec for %s",
      (file) => { expect(selectViewModes(input([file])).mode).toBe("all"); },
    );
  });

  describe("svelteStyleChanged", () => {
    const component = (script: string, markup: string, css = ".a{}") => `<script>${script}</script>\n${markup}\n<style>${css}</style>`;

    it("ignores script-only edits", () => {
      expect(svelteStyleChanged(component("let a = 1;", "<p>{a}</p>"), component("let a = 2;", "<p>{a}</p>"))).toBe(false);
    });

    it.each([
      ["a style block", component("", "<p></p>", ".a{}"), component("", "<p></p>", ".a{top:0}")],
      ["an added style block", "<p></p>", component("", "<p></p>")],
      ["a class attribute", component("", "<p class=\"a\"></p>"), component("", "<p class=\"b\"></p>")],
      ["a class directive", component("", "<p></p>"), component("", "<p class:a={x}></p>")],
      ["an inline style", component("", "<p></p>"), component("", "<p style=\"top: 0\"></p>")],
      ["a style directive", component("", "<p></p>"), component("", "<p style:top={y}></p>")],
    ])("detects %s", (_label, before, after) => {
      expect(svelteStyleChanged(before, after)).toBe(true);
    });

    it("treats an added or deleted component as styling", () => {
      expect(svelteStyleChanged(null, "<p></p>")).toBe(true);
      expect(svelteStyleChanged("<p></p>", null)).toBe(true);
    });

    it("judges only frontend sources", () => {
      expect(webkitSensitivity("e2e/preview.spec.ts", () => null)).toBeNull();
      expect(webkitSensitivity("src/lib/domain/quick-open-search.ts", () => null)).toBeNull();
    });
  });

  describe("unionSelections", () => {
    const sel = (mode: "all" | "selected" | "none", items: string[] = []) => ({ mode, reason: mode, items });

    it("selects every spec either code map selects", () => {
      expect(unionSelections([sel("selected", ["e2e/a.spec.ts"]), sel("selected", ["e2e/b.spec.ts"])], 2)).toMatchObject({
        mode: "selected", items: ["e2e/a.spec.ts", "e2e/b.spec.ts"],
      });
      expect(unionSelections([sel("none"), sel("selected", ["e2e/b.spec.ts"])], 2).items).toEqual(["e2e/b.spec.ts"]);
    });

    it("runs everything when either map does", () => {
      expect(unionSelections([sel("selected", ["e2e/a.spec.ts"]), sel("all")], 2).mode).toBe("all");
    });
  });
});
