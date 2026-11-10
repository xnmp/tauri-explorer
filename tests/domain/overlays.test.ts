import { describe, expect, it } from "vitest";
import {
  NO_OVERLAYS,
  OVERLAY_IDS,
  anyOverlayOpen,
  closeAllOverlays,
  closeOverlay,
  isOverlayOpen,
  openOverlay,
  toggleOverlay,
} from "$lib/domain/overlays";

describe("overlay registry", () => {
  it("has unique ids", () => {
    expect(new Set(OVERLAY_IDS).size).toBe(OVERLAY_IDS.length);
  });

  it("starts with nothing open", () => {
    expect(anyOverlayOpen(NO_OVERLAYS)).toBe(false);
  });

  it("opens and closes without mutating the previous set", () => {
    const opened = openOverlay(NO_OVERLAYS, "about");
    expect(isOverlayOpen(opened, "about")).toBe(true);
    expect(isOverlayOpen(NO_OVERLAYS, "about")).toBe(false);
    const closed = closeOverlay(opened, "about");
    expect(isOverlayOpen(closed, "about")).toBe(false);
    expect(isOverlayOpen(opened, "about")).toBe(true);
  });

  it("opening twice and closing an unopened id are no-ops on membership", () => {
    const once = openOverlay(openOverlay(NO_OVERLAYS, "settings"), "settings");
    expect([...once]).toEqual(["settings"]);
    expect(anyOverlayOpen(closeOverlay(NO_OVERLAYS, "plugins"))).toBe(false);
  });

  it("closes the listed peers when opening, and only those", () => {
    let open = openOverlay(NO_OVERLAYS, "commandPalette");
    open = openOverlay(open, "settings");
    open = openOverlay(open, "about", ["commandPalette"]);
    expect(isOverlayOpen(open, "commandPalette")).toBe(false);
    expect(isOverlayOpen(open, "settings")).toBe(true);
    expect(isOverlayOpen(open, "about")).toBe(true);
  });

  it("keeps the opened id open even if it is listed among the peers", () => {
    expect(isOverlayOpen(openOverlay(NO_OVERLAYS, "about", ["about"]), "about")).toBe(true);
  });

  it("toggles", () => {
    const on = toggleOverlay(NO_OVERLAYS, "jobsPanel");
    expect(isOverlayOpen(on, "jobsPanel")).toBe(true);
    expect(isOverlayOpen(toggleOverlay(on, "jobsPanel"), "jobsPanel")).toBe(false);
  });

  it("closeAll empties any set, including every registered id", () => {
    const all = OVERLAY_IDS.reduce((s, id) => openOverlay(s, id), NO_OVERLAYS);
    expect(anyOverlayOpen(all)).toBe(true);
    expect(anyOverlayOpen(closeAllOverlays())).toBe(false);
    expect(all.size).toBe(OVERLAY_IDS.length);
  });

  it("any reports true for each single open id", () => {
    for (const id of OVERLAY_IDS) expect(anyOverlayOpen(openOverlay(NO_OVERLAYS, id))).toBe(true);
  });
});
