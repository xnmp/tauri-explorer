/**
 * macOS vibrancy window config (#1733): every explorer window — the Rust-built
 * main window and the fresh/warm windows created from JS — gets the same
 * transparency and material for the user's vibrancy settings, and nothing
 * changes off macOS or with vibrancy off.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MACOS_VIBRANCY_MATERIAL,
  macOsVibrancyMode,
  macOsWindowVibrancy,
} from "$lib/domain/macos-vibrancy";

// Literal path so the unit-test selector's text scan finds this input.
const LIB_RS = new URL("../../src-tauri/src/lib.rs", import.meta.url);

describe("macOsVibrancyMode", () => {
  it("is off on every platform but macOS, whatever the settings", () => {
    expect(macOsVibrancyMode(false, { macOsVibrancy: true, vibrancyBlur: true })).toBe("off");
    expect(macOsVibrancyMode(false, { macOsVibrancy: true, vibrancyBlur: false })).toBe("off");
  });

  it("is off on macOS while Window Vibrancy is off", () => {
    expect(macOsVibrancyMode(true, { macOsVibrancy: false, vibrancyBlur: true })).toBe("off");
    expect(macOsVibrancyMode(true, { macOsVibrancy: false, vibrancyBlur: false })).toBe("off");
  });

  it("shows the material with Native Blur on, and only transparency with it off", () => {
    expect(macOsVibrancyMode(true, { macOsVibrancy: true, vibrancyBlur: true })).toBe("material");
    expect(macOsVibrancyMode(true, { macOsVibrancy: true, vibrancyBlur: false })).toBe("transparent");
  });

  it("defaults Native Blur on, like the Rust settings reader", () => {
    expect(macOsVibrancyMode(true, { macOsVibrancy: true })).toBe("material");
  });

  it("never turns transparency on from missing or malformed settings", () => {
    expect(macOsVibrancyMode(true, null)).toBe("off");
    expect(macOsVibrancyMode(true, undefined)).toBe("off");
    expect(macOsVibrancyMode(true, {})).toBe("off");
    const malformed = { macOsVibrancy: "true", vibrancyBlur: 1 } as unknown as { macOsVibrancy: boolean };
    expect(macOsVibrancyMode(true, malformed)).toBe("off");
  });

  it("treats a non-boolean Native Blur as the default (on)", () => {
    const blur = { macOsVibrancy: true, vibrancyBlur: "no" } as unknown as { macOsVibrancy: boolean };
    expect(macOsVibrancyMode(true, blur)).toBe("material");
  });
});

describe("macOsWindowVibrancy", () => {
  it("leaves the window's platform defaults alone when off", () => {
    expect(macOsWindowVibrancy(false, { macOsVibrancy: true, vibrancyBlur: true })).toBeUndefined();
    expect(macOsWindowVibrancy(true, { macOsVibrancy: false, vibrancyBlur: true })).toBeUndefined();
  });

  it("makes the window transparent without a material when Native Blur is off", () => {
    expect(macOsWindowVibrancy(true, { macOsVibrancy: true, vibrancyBlur: false })).toEqual({ transparent: true });
  });

  it("uses the active Sidebar material when Native Blur is on", () => {
    expect(macOsWindowVibrancy(true, { macOsVibrancy: true, vibrancyBlur: true })).toEqual({
      transparent: true,
      effects: { material: "sidebar", state: "active" },
    });
  });
});

describe("parity with the Rust-built main window", () => {
  it("names the same material as src-tauri/src/lib.rs", () => {
    const source = readFileSync(LIB_RS, "utf8");
    const match = /const MACOS_VIBRANCY_MATERIAL:[^=]*=\s*tauri::utils::WindowEffect::(\w+)\s*;/.exec(source);
    expect(match, "lib.rs must declare MACOS_VIBRANCY_MATERIAL").not.toBeNull();
    // Tauri serializes WindowEffect variants in camelCase.
    const variant = match![1];
    expect(variant[0].toLowerCase() + variant.slice(1)).toBe(MACOS_VIBRANCY_MATERIAL);
    // The main window must build its effects from that constant, with the
    // same active state the JS windows request.
    expect(source).toMatch(/effects:\s*vec!\[MACOS_VIBRANCY_MATERIAL\]/);
    expect(source).toMatch(/state:\s*Some\(tauri::utils::WindowEffectState::Active\)/);
    expect(source).toMatch(/builder\.effects\(macos_vibrancy_effects\(\)\)/);
  });
});
