import { describe, expect, it } from "vitest";
import { changeEmitter, FOCUS_TARGETS, focusIsLost, forwardWindowControls, pickFocusTarget } from "$lib/state/site-demo-bridge-seams";
import { SITE_DEMO_BUILD, windowControlRoute, type WindowControlAction } from "$lib/api/window-controls";

type Node = { name: string; querySelector(selector: string): Node | null };
const pane = (has: Record<string, string>): Node => ({
  name: "pane",
  querySelector: (selector) => (has[selector] ? { name: has[selector], querySelector: () => null } : null),
});

describe("focusApp's target", () => {
  it("prefers the selected row, then the focusable row, then the list viewport, then the pane", () => {
    const [selected, focusable, viewport] = FOCUS_TARGETS;
    expect(pickFocusTarget(pane({ [selected]: "sel", [focusable]: "row", [viewport]: "vp" }))?.name).toBe("sel");
    expect(pickFocusTarget(pane({ [focusable]: "row", [viewport]: "vp" }))?.name).toBe("row");
    expect(pickFocusTarget(pane({ [viewport]: "vp" }))?.name).toBe("vp");
    expect(pickFocusTarget(pane({}))?.name).toBe("pane");
    expect(pickFocusTarget(null)).toBeNull();
  });

  it("restores focus only when nothing in the frame holds it", () => {
    const body = {};
    expect(focusIsLost(null, body)).toBe(true);
    expect(focusIsLost(body, body)).toBe(true);
    expect(focusIsLost({}, body)).toBe(false);
  });
});

describe("appearance events", () => {
  it("emits the first value and each change, never a repeat", () => {
    const seen: unknown[] = [];
    const publish = changeEmitter((value) => seen.push(value));
    publish({ colorScheme: "dark", material: null });
    publish({ colorScheme: "dark", material: null });
    publish({ colorScheme: "dark", material: "acrylic" });
    publish({ colorScheme: "light", material: "acrylic" });
    publish({ colorScheme: "light", material: "acrylic" });
    expect(seen).toEqual([
      { colorScheme: "dark", material: null },
      { colorScheme: "dark", material: "acrylic" },
      { colorScheme: "light", material: "acrylic" },
    ]);
  });
});

describe("window controls", () => {
  it("the site demo forwards each button to its host as a window-control event", () => {
    const events: [string, unknown][] = [];
    const control: { windowControl?: (action: WindowControlAction) => void } = {};
    forwardWindowControls(control, (event, data) => events.push([event, data]));
    control.windowControl!("close");
    control.windowControl!("minimize");
    expect(events).toEqual([["window-control", { action: "close" }], ["window-control", { action: "minimize" }]]);
  });

  it("routes the buttons: host in the site demo, the app's close sequence elsewhere (review D9)", () => {
    // Ordinary browser build: close runs the app's own close flow, as before the demo.
    expect(windowControlRoute("close", { nativeWindow: false, hostOwnsWindow: false })).toBe("close-flow");
    expect(windowControlRoute("minimize", { nativeWindow: false, hostOwnsWindow: false })).toBe("none");
    expect(windowControlRoute("maximize", { nativeWindow: false, hostOwnsWindow: false })).toBe("none");
    // Native window.
    expect(windowControlRoute("close", { nativeWindow: true, hostOwnsWindow: false })).toBe("close-flow");
    expect(windowControlRoute("minimize", { nativeWindow: true, hostOwnsWindow: false })).toBe("native");
    // Site demo: every button goes to the host.
    for (const action of ["close", "minimize", "maximize"] as const) {
      expect(windowControlRoute(action, { nativeWindow: false, hostOwnsWindow: true })).toBe("host");
    }
  });

  it("is not the site demo in an ordinary build", () => {
    expect(SITE_DEMO_BUILD).toBe(false);
  });
});

describe("the overlay event's kind", async () => {
  const { overlayKind } = await import("$lib/state/site-demo-bridge-seams");
  const none = { isQuickOpenOpen: false, isCommandPaletteOpen: false, isContentSearchOpen: false, isThemePickerOpen: false, isKeybindingsOpen: false, isSettingsOpen: false };

  it("names the open overlay", () => {
    expect(overlayKind({ ...none, isQuickOpenOpen: true })).toBe("quick-open");
    expect(overlayKind({ ...none, isCommandPaletteOpen: true })).toBe("command-palette");
    expect(overlayKind({ ...none, isContentSearchOpen: true })).toBe("content-search");
    expect(overlayKind({ ...none, isThemePickerOpen: true })).toBe("theme-picker");
    expect(overlayKind({ ...none, isKeybindingsOpen: true })).toBe("keybindings");
    expect(overlayKind({ ...none, isSettingsOpen: true })).toBe("settings");
  });

  it("is null when none of them is open (another dialog, or nothing)", () => {
    expect(overlayKind(none)).toBeNull();
  });

  it("prefers Quick Open when two report open at once", () => {
    expect(overlayKind({ ...none, isQuickOpenOpen: true, isSettingsOpen: true })).toBe("quick-open");
  });
});
