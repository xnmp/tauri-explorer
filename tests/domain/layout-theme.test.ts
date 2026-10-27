/**
 * Layout theme catalog, metadata, resolution and fallback (#1306).
 */
import { describe, it, expect } from "vitest";
import {
  BUILTIN_LAYOUT_CATALOG,
  DEFAULT_DETAILS_ROW_HEIGHT,
  MAX_LAYOUT_CSS_BYTES,
  buildLayoutCatalog,
  describeLayoutFallback,
  isNewLayoutFallback,
  layoutNameFromFilename,
  parseLayoutMetadata,
  parseLayoutRowHeight,
  parseUserLayout,
  resolveLayoutTheme,
  withLayoutFailure,
} from "$lib/domain/layout-theme";
import { legacyLayoutThemeId, withLegacyLayoutMirror } from "$lib/domain/layout-theme-ids";
import { migrateSettings } from "$lib/domain/settings-migration";

const COMPACT = `/*
 * @name Compact
 * @description Tight gaps.
 * @extends floating-islands
 */
:root { --layout-gap: 2px; }`;

describe("parseLayoutMetadata", () => {
  it("reads name, description and base from the leading comment", () => {
    expect(parseLayoutMetadata(COMPACT)).toEqual({
      name: "Compact",
      description: "Tight gaps.",
      extends: "floating-islands",
    });
  });

  it("treats metadata as optional", () => {
    expect(parseLayoutMetadata(":root { --layout-gap: 0; }")).toEqual({});
  });

  it("ignores a BOM and leading whitespace, and keeps the first duplicate key", () => {
    expect(parseLayoutMetadata("﻿\n  /* @name One\n@name Two */ a{}")?.name).toBe("One");
  });

  it("rejects a leading comment that never closes", () => {
    expect(parseLayoutMetadata("/* @name Broken\n:root { --layout-gap: 1px; }")).toBeNull();
  });

  it("clips absurdly long metadata", () => {
    const name = parseLayoutMetadata(`/* @name ${"x".repeat(5000)} */`)?.name ?? "";
    expect(name.length).toBe(80);
    expect(name.endsWith("…")).toBe(true);
  });
});

describe("parseUserLayout", () => {
  it("derives a user catalog entry whose id is the file name", () => {
    const parsed = parseUserLayout("compact.css", COMPACT);
    expect(parsed).toMatchObject({
      ok: true,
      theme: { id: "compact.css", name: "Compact", source: "user", base: "floating-islands", arrangement: "islands" },
    });
  });

  it("names an unlabeled layout after its file and extends Default", () => {
    const parsed = parseUserLayout("my-dense_layout.css", "a { color: red; }");
    expect(parsed).toMatchObject({ ok: true, theme: { name: "My Dense Layout", base: "default", arrangement: "flat" } });
  });

  it("falls back to Default for an unknown base", () => {
    const parsed = parseUserLayout("x.css", "/* @extends ../../etc */ a {}");
    expect(parsed).toMatchObject({ ok: true, theme: { base: "default" } });
  });

  it.each([
    ["../escape.css", "a{}", "invalid-filename"],
    ["sub/dir.css", "a{}", "invalid-filename"],
    [".hidden.css", "a{}", "invalid-filename"],
    ["notes.txt", "a{}", "invalid-filename"],
    ["SHOUT.CSS", "a{}", "invalid-filename"],
    [null, "a{}", "invalid-filename"],
    ["empty.css", "", "empty"],
    ["blank.css", "  \n\t ", "empty"],
    ["binary.css", null, "unreadable"],
    ["open.css", "/* @name Open", "unterminated-comment"],
  ])("rejects %s (%j) as %s", (filename, css, reason) => {
    expect(parseUserLayout(filename, css)).toMatchObject({ ok: false, reason });
  });

  it("rejects a stylesheet over the size limit, counting UTF-8 bytes", () => {
    expect(parseUserLayout("huge.css", "a".repeat(MAX_LAYOUT_CSS_BYTES + 1))).toMatchObject({ ok: false, reason: "too-large" });
    // 3-byte characters: under the limit in UTF-16 units, over it in bytes.
    const wide = "€".repeat(Math.ceil(MAX_LAYOUT_CSS_BYTES / 3) + 1);
    expect(wide.length).toBeLessThan(MAX_LAYOUT_CSS_BYTES);
    expect(parseUserLayout("wide.css", wide)).toMatchObject({ ok: false, reason: "too-large" });
    expect(parseUserLayout("limit.css", "a".repeat(MAX_LAYOUT_CSS_BYTES))).toMatchObject({ ok: true });
  });
});

describe("buildLayoutCatalog", () => {
  it("lists built-ins first, then usable user layouts by name, recording failures", () => {
    const catalog = buildLayoutCatalog([
      { filename: "zeta.css", css: "/* @name Alpha */ a{}" },
      { filename: "beta.css", css: "b{}" },
      { filename: "empty.css", css: "" },
      { filename: "big.css", css: null, error: "too-large" },
      { filename: "beta.css", css: "/* @name Duplicate */ c{}" },
      "garbage",
      null,
      { css: "no filename" },
    ]);
    expect(catalog.themes.map((theme) => theme.id)).toEqual([
      "default", "floating-islands", "hairline-ledger", "zeta.css", "beta.css",
    ]);
    expect(catalog.userCss.get("beta.css")).toBe("b{}");
    expect(Object.fromEntries(catalog.failures)).toEqual({ "empty.css": "empty", "big.css": "too-large" });
  });

  it("degrades a malformed listing to the built-ins", () => {
    expect(buildLayoutCatalog({ not: "an array" })).toBe(BUILTIN_LAYOUT_CATALOG);
    expect(buildLayoutCatalog(undefined).themes).toHaveLength(3);
  });
});

describe("resolveLayoutTheme", () => {
  const catalog = buildLayoutCatalog([
    { filename: "compact.css", css: COMPACT },
    { filename: "empty.css", css: "" },
  ]);

  it("applies built-ins and usable user layouts as requested", () => {
    expect(resolveLayoutTheme(catalog, "hairline-ledger")).toMatchObject({ theme: { id: "hairline-ledger" }, fallback: null });
    expect(resolveLayoutTheme(catalog, "compact.css")).toMatchObject({ theme: { id: "compact.css" }, fallback: null });
  });

  it("falls back to Default, explaining why, without rewriting the request", () => {
    expect(resolveLayoutTheme(catalog, "gone.css")).toEqual({
      theme: expect.objectContaining({ id: "default" }),
      fallback: { requested: "gone.css", reason: "missing" },
    });
    expect(resolveLayoutTheme(catalog, "empty.css").fallback).toEqual({ requested: "empty.css", reason: "empty" });
  });

  it("treats an absent or malformed request as Default without a notice", () => {
    for (const requested of [undefined, null, "", 42, {}]) {
      expect(resolveLayoutTheme(catalog, requested)).toMatchObject({ theme: { id: "default" }, fallback: null });
    }
  });

  it("re-resolves a layout whose CSS turned out to contain no rules", () => {
    const failed = withLayoutFailure(catalog, "compact.css", "no-rules");
    expect(resolveLayoutTheme(failed, "compact.css").fallback).toEqual({ requested: "compact.css", reason: "no-rules" });
    expect(withLayoutFailure(catalog, "hairline-ledger", "no-rules")).toBe(catalog);
  });
});

describe("isNewLayoutFallback", () => {
  const missing = { requested: "a.css", reason: "missing" } as const;
  it("reports each distinct failure once", () => {
    expect(isNewLayoutFallback(null, missing)).toBe(true);
    expect(isNewLayoutFallback(missing, { ...missing })).toBe(false);
    expect(isNewLayoutFallback(missing, { requested: "a.css", reason: "empty" })).toBe(true);
    expect(isNewLayoutFallback(missing, null)).toBe(false);
  });
});

describe("parseLayoutRowHeight", () => {
  it.each([
    ["28px", 28],
    [" 26 ", 26],
    ["27.6px", 28],
    ["4px", 20],
    ["400px", 64],
    ["", DEFAULT_DETAILS_ROW_HEIGHT],
    ["2em", DEFAULT_DETAILS_ROW_HEIGHT],
    ["calc(1px + 2px)", DEFAULT_DETAILS_ROW_HEIGHT],
    ["-30px", DEFAULT_DETAILS_ROW_HEIGHT],
    [undefined, DEFAULT_DETAILS_ROW_HEIGHT],
  ])("parses %j as %i", (raw, expected) => {
    expect(parseLayoutRowHeight(raw)).toBe(expected);
  });
});

describe("legacy Floating Islands preference (#277, #434)", () => {
  it.each([
    [{ floatingIslands: true }, "floating-islands"],
    [{ macOsVibrancy: true }, "floating-islands"],
    [{ windowsBackdrop: "mica" }, "floating-islands"],
    [{ windowsBackdrop: "off" }, "default"],
    [{}, "default"],
    [null, "default"],
    ["corrupt", "default"],
  ])("maps %j to %s", (blob, expected) => {
    expect(legacyLayoutThemeId(blob)).toBe(expected);
  });

  it("migrates once through the settings ledger and never overrides a chosen layout", () => {
    const defaults = { layoutTheme: "default", floatingIslands: false, settingsVersion: 2 };
    const legacy = migrateSettings({ floatingIslands: true, settingsVersion: 1 }, defaults);
    expect(legacy).toEqual({ settings: expect.objectContaining({ layoutTheme: "floating-islands", settingsVersion: 2 }), changed: true });

    const chosen = migrateSettings({ floatingIslands: true, layoutTheme: "hairline-ledger", settingsVersion: 1 }, defaults);
    expect(chosen.settings.layoutTheme).toBe("hairline-ledger");

    const current = migrateSettings({ floatingIslands: true, layoutTheme: "default", settingsVersion: 2 }, defaults);
    expect(current).toEqual({ settings: expect.objectContaining({ layoutTheme: "default" }), changed: false });
  });
});

describe("withLegacyLayoutMirror", () => {
  it("mirrors built-in choices into the deprecated toggle for downgraded builds", () => {
    expect(withLegacyLayoutMirror({ layoutTheme: "floating-islands" })).toEqual({ layoutTheme: "floating-islands", floatingIslands: true });
    expect(withLegacyLayoutMirror({ layoutTheme: "hairline-ledger" })).toEqual({ layoutTheme: "hairline-ledger", floatingIslands: false });
  });

  it("leaves user layouts, explicit toggles and unrelated patches alone", () => {
    expect(withLegacyLayoutMirror({ layoutTheme: "mine.css" })).toEqual({ layoutTheme: "mine.css" });
    expect(withLegacyLayoutMirror({ layoutTheme: "default", floatingIslands: true })).toEqual({ layoutTheme: "default", floatingIslands: true });
    expect(withLegacyLayoutMirror({})).toEqual({});
  });
});

describe("describeLayoutFallback", () => {
  it("explains every reason", () => {
    for (const reason of ["missing", "invalid-filename", "unreadable", "empty", "too-large", "unterminated-comment", "no-rules", "load-failed"] as const) {
      expect(describeLayoutFallback(reason)).toMatch(/\w/);
    }
  });
});

describe("layoutNameFromFilename", () => {
  it("keeps a name with no stem readable", () => {
    expect(layoutNameFromFilename("---.css")).toBe("---.css");
    expect(layoutNameFromFilename("ünïcode-layout.css")).toBe("Ünïcode Layout");
  });
});
