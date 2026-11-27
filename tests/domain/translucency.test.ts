/**
 * Window translucency (#1757): one setting, each platform's own material.
 * Every explorer window (the Rust-built main window and the fresh/warm
 * windows created from JS) gets the same material for the same settings, a
 * page with no published material behaves like its platform, and a malformed
 * settings blob never makes a window transparent.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MACOS_VIBRANCY_MATERIAL,
  activeMaterial,
  builtWindowMaterial,
  isTranslucencyMaterial,
  legacyTranslucency,
  materialEffects,
  platformMaterial,
  WINDOW_MATERIAL_PARAM,
  withWindowMaterial,
} from "$lib/domain/translucency";

// Literal path so the unit-test selector's text scan finds this input.
const TRANSLUCENCY_RS = new URL("../../src-tauri/src/translucency.rs", import.meta.url);

const MAC = { isMac: true, isWindows: false };
const WINDOWS = { isMac: false, isWindows: true };
const LINUX = { isMac: false, isWindows: false };

describe("platformMaterial", () => {
  it("takes the material the native side published", () => {
    expect(platformMaterial("mica", WINDOWS)).toBe("mica");
    expect(platformMaterial("acrylic", WINDOWS)).toBe("acrylic");
    expect(platformMaterial("vibrancy", MAC)).toBe("vibrancy");
  });

  it("has none where the native side published none (Windows 10)", () => {
    expect(platformMaterial(null, WINDOWS)).toBeNull();
  });

  it("falls back to the platform's material when nothing was published (browser build)", () => {
    expect(platformMaterial(undefined, MAC)).toBe("vibrancy");
    expect(platformMaterial(undefined, WINDOWS)).toBe("acrylic");
    expect(platformMaterial(undefined, LINUX)).toBeNull();
  });

  it("ignores a malformed published value", () => {
    expect(platformMaterial("glass", LINUX)).toBeNull();
    expect(platformMaterial(42, MAC)).toBe("vibrancy");
    expect(isTranslucencyMaterial("Mica")).toBe(false);
  });
});

describe("activeMaterial", () => {
  it("shows the platform's material only while the setting is on", () => {
    expect(activeMaterial("acrylic", true)).toBe("acrylic");
    expect(activeMaterial("acrylic", false)).toBeNull();
    expect(activeMaterial(null, true)).toBeNull();
  });

  it("never turns a material on from a malformed setting", () => {
    for (const value of ["true", 1, null, undefined, {}]) expect(activeMaterial("vibrancy", value)).toBeNull();
  });
});

describe("materialEffects", () => {
  it("uses the active Sidebar material on macOS and the backdrop itself on Windows", () => {
    expect(materialEffects("vibrancy")).toEqual({ effects: ["sidebar"], state: "active" });
    expect(materialEffects("acrylic")).toEqual({ effects: ["acrylic"] });
    expect(materialEffects("mica")).toEqual({ effects: ["mica"] });
  });
});

describe("builtWindowMaterial", () => {
  it("reads what a JS window's creator put in its launch URL", () => {
    const launch = new URLSearchParams({ path: "/a b", warm: "1" });
    for (const material of ["vibrancy", "acrylic", "mica", null] as const) {
      const search = `?${withWindowMaterial(launch, material).toString()}`;
      expect(builtWindowMaterial(undefined, search)).toBe(material);
      // The other launch parameters are untouched, and so is the input.
      expect(new URLSearchParams(search).get("path")).toBe("/a b");
    }
    expect(launch.has("material")).toBe(false);
  });

  it("prefers the Rust main window's injected material", () => {
    expect(builtWindowMaterial("vibrancy", "?material=none")).toBe("vibrancy");
    expect(builtWindowMaterial(null, "?material=acrylic")).toBeNull();
  });

  it("is unknown when neither says, or says something malformed (browser build)", () => {
    expect(builtWindowMaterial(undefined, "")).toBeUndefined();
    expect(builtWindowMaterial(undefined, "?path=/x")).toBeUndefined();
    expect(builtWindowMaterial(undefined, "?material=frosted")).toBeUndefined();
    expect(builtWindowMaterial(42, "?material=")).toBeUndefined();
  });

  it("survives a renderer recovery reload, which keeps all but the parking parameter", () => {
    expect(builtWindowMaterial(undefined, "?path=/x&material=mica&rendererRecovery=1")).toBe("mica");
  });
});

describe("legacyTranslucency", () => {
  it("keeps a translucent window for anyone who had macOS vibrancy or a Windows backdrop", () => {
    expect(legacyTranslucency({ macOsVibrancy: true })).toBe(true);
    expect(legacyTranslucency({ macOsVibrancy: true, vibrancyBlur: false })).toBe(true);
    expect(legacyTranslucency({ windowsBackdrop: "mica" })).toBe(true);
    expect(legacyTranslucency({ windowsBackdrop: "acrylic" })).toBe(true);
  });

  it("is off for everyone else and for malformed blobs", () => {
    for (const blob of [{}, { windowsBackdrop: "off" }, { macOsVibrancy: "true" }, null, "x", [true]]) {
      expect(legacyTranslucency(blob)).toBe(false);
    }
  });
});

describe("parity with the native side", () => {
  const source = readFileSync(TRANSLUCENCY_RS, "utf8");

  it("names the same macOS material as src-tauri/src/translucency.rs", () => {
    const match = /const MACOS_VIBRANCY_MATERIAL:[^=]*=\s*WindowEffect::(\w+)\s*;/.exec(source);
    expect(match, "translucency.rs must declare MACOS_VIBRANCY_MATERIAL").not.toBeNull();
    // Tauri serializes WindowEffect variants in camelCase.
    const variant = match![1];
    expect(variant[0].toLowerCase() + variant.slice(1)).toBe(MACOS_VIBRANCY_MATERIAL);
  });

  it("publishes the material names this module accepts", () => {
    for (const name of ["vibrancy", "acrylic", "mica"]) {
      expect(source).toContain(`=> "${name}"`);
      expect(isTranslucencyMaterial(name)).toBe(true);
    }
    expect(source).toContain("__TRANSLUCENCY_MATERIAL__");
  });

  it("names the per-window material the way the page and its pre-paint read it", () => {
    expect(source).toContain("\"__WINDOW_MATERIAL__\"");
    // app.html cannot import this module, so it repeats builtWindowMaterial.
    const prePaint = readFileSync(new URL("../../src/app.html", import.meta.url), "utf8");
    expect(prePaint).toContain("window.__WINDOW_MATERIAL__");
    expect(prePaint).toContain("get('material')");
    for (const name of ["vibrancy", "acrylic", "mica"]) expect(prePaint).toContain(`'${name}'`);
  });

  it("reads a JS-created window's material from the URL parameter the page writes (#1903)", () => {
    const match = /const WINDOW_MATERIAL_PARAM: &str = "(\w+)";/.exec(source);
    expect(match, "translucency.rs must declare WINDOW_MATERIAL_PARAM").not.toBeNull();
    expect(match![1]).toBe(WINDOW_MATERIAL_PARAM);
    // The URL a window is created with carries the material under that name.
    const query = withWindowMaterial(new URLSearchParams({ path: "C:\\" }), "acrylic");
    expect(query.get(match![1])).toBe("acrylic");
  });
});
