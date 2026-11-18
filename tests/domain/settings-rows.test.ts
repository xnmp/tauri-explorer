import { describe, expect, it } from "vitest";
import { SETTINGS_ROWS, settingsSectionRows } from "$lib/domain/settings-rows";
import { matchesSettingsQuery } from "$lib/domain/settings-search";

const linux = { isMac: false, isWindows: false };
const mac = { isMac: true, isWindows: false };
const windows = { isMac: false, isWindows: true };

/** Mirrors the dialog's section visibility: any row matches the query. */
function sectionMatches(rows: string[][], query: string): boolean {
  return rows.some((terms) => matchesSettingsQuery(query, ...terms));
}

describe("SETTINGS_ROWS", () => {
  it("gives every row a non-empty label and description", () => {
    for (const [key, terms] of Object.entries(SETTINGS_ROWS)) {
      expect(terms.length, key).toBeGreaterThanOrEqual(2);
      for (const term of terms) expect(term.trim(), key).not.toBe("");
    }
  });
});

describe("settingsSectionRows", () => {
  it("shows macOS-only appearance rows only on macOS", () => {
    expect(settingsSectionRows(mac).appearance).toContain(SETTINGS_ROWS.integratedTitleBar);
    expect(settingsSectionRows(linux).appearance).not.toContain(SETTINGS_ROWS.integratedTitleBar);
    expect(settingsSectionRows(windows).appearance).not.toContain(SETTINGS_ROWS.vibrancy);
  });

  it("shows Translucency Opacity only on macOS with the Native Blur material", () => {
    const row = SETTINGS_ROWS.translucencyOpacity;
    expect(settingsSectionRows({ ...mac, macMaterial: true }).appearance).toContain(row);
    expect(settingsSectionRows(mac).appearance).not.toContain(row);
    expect(settingsSectionRows({ ...mac, macMaterial: false }).appearance).not.toContain(row);
    expect(settingsSectionRows({ ...linux, macMaterial: true }).appearance).not.toContain(row);
    expect(settingsSectionRows({ ...windows, macMaterial: true }).appearance).not.toContain(row);
  });

  it("shows Windows-only appearance rows only on Windows", () => {
    expect(settingsSectionRows(windows).appearance).toContain(SETTINGS_ROWS.windowsBackdrop);
    expect(settingsSectionRows(mac).appearance).not.toContain(SETTINGS_ROWS.windowsBackdrop);
    expect(settingsSectionRows(linux).appearance).not.toContain(SETTINGS_ROWS.windowsBackdropOpacity);
  });

  it("keeps platform-independent sections identical across platforms", () => {
    const [l, m, w] = [linux, mac, windows].map(settingsSectionRows);
    for (const key of ["navBar", "behavior", "terminal"] as const) {
      expect(m[key]).toEqual(l[key]);
      expect(w[key]).toEqual(l[key]);
    }
  });

  it("matches sections by row description text", () => {
    const rows = settingsSectionRows(linux);
    expect(sectionMatches(rows.appearance, "color theme")).toBe(true);
    expect(sectionMatches(rows.navBar, "color theme")).toBe(false);
    expect(sectionMatches(rows.terminal, "zqxj")).toBe(false);
  });

  it("matches every section on an empty query", () => {
    const rows = settingsSectionRows(linux);
    for (const section of Object.values(rows)) expect(sectionMatches(section, "")).toBe(true);
  });
});

describe("Show Window Controls row (#1756)", () => {
  const terms = SETTINGS_ROWS.windowControls;
  it("is listed on Linux and Windows", () => {
    expect(settingsSectionRows(linux).appearance).toContain(terms);
    expect(settingsSectionRows(windows).appearance).toContain(terms);
  });
  it("is absent on macOS, which always has native traffic lights", () => {
    expect(settingsSectionRows(mac).appearance).not.toContain(terms);
  });
});
