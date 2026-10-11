/**
 * The Preview pane's fullscreen controller (#1033): one state machine for
 * file images and plugin Preview targets. Driven through the same handlers
 * the image surface and the window keydown listener call.
 */
import { describe, expect, it, vi } from "vitest";
import { createPreviewFullscreen } from "$lib/composables/use-preview-fullscreen.svelte";
import { KEY_PAN_STEP, KEY_ZOOM_STEP, MAX_ZOOM } from "$lib/domain/image-viewer-zoom";

function key(k: string) {
  return { key: k, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() };
}
function click() {
  return { stopPropagation: vi.fn() };
}
function pointer(clientX: number, clientY: number, button = 0) {
  return { button, clientX, clientY, pointerId: 1, currentTarget: null };
}
function wheel(deltaY: number, clientX = 0, clientY = 0) {
  return { deltaY, clientX, clientY, preventDefault: vi.fn() };
}
/** A container whose centre is the client origin. */
function containerAtOrigin(): HTMLElement {
  return { getBoundingClientRect: () => ({ left: -100, top: -100, width: 200, height: 200 }) } as unknown as HTMLElement;
}

describe("createPreviewFullscreen", () => {
  it("a clean click at fit zoom enters and leaves fullscreen", () => {
    const fs = createPreviewFullscreen();
    fs.click(click());
    expect(fs.active).toBe(true);
    expect(fs.transform).toBe("scale(1)");
    fs.click(click());
    expect(fs.active).toBe(false);
    expect(fs.transform).toBe("");
  });

  it("toggle runs onToggle; Esc and exit do not, and both reset the zoom", () => {
    const onToggle = vi.fn();
    const fs = createPreviewFullscreen({ onToggle });
    fs.toggle();
    expect(onToggle).toHaveBeenCalledTimes(1);
    fs.handleKey(key("+"));
    const esc = key("Escape");
    fs.handleKey(esc);
    expect(fs.active).toBe(false);
    expect(fs.zoom).toBe(1);
    expect(esc.preventDefault).toHaveBeenCalled();
    expect(esc.stopImmediatePropagation).toHaveBeenCalled();
    fs.toggle();
    fs.handleKey(key("+"));
    fs.exit();
    expect(fs.active).toBe(false);
    expect(fs.zoom).toBe(1);
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it("ignores keys while not fullscreen", () => {
    const fs = createPreviewFullscreen();
    const plus = key("+");
    fs.handleKey(plus);
    expect(fs.zoom).toBe(1);
    expect(plus.preventDefault).not.toHaveBeenCalled();
  });

  it("zooms with +/-, resets with 0, and consumes those keys", () => {
    const fs = createPreviewFullscreen();
    fs.toggle();
    fs.handleKey(key("+"));
    expect(fs.zoom).toBeCloseTo(KEY_ZOOM_STEP);
    expect(fs.transform).toContain(`scale(${fs.zoom})`);
    fs.handleKey(key("-"));
    expect(fs.zoom).toBeCloseTo(1);
    for (let i = 0; i < 30; i++) fs.handleKey(key("="));
    expect(fs.zoom).toBe(MAX_ZOOM);
    fs.handleKey(key("0"));
    expect(fs.zoom).toBe(1);
  });

  it("at the base zoom, Left/Right navigate when the subject has siblings", () => {
    const navigate = vi.fn();
    const fs = createPreviewFullscreen({ navigate });
    fs.toggle();
    fs.handleKey(key("ArrowRight"));
    fs.handleKey(key("ArrowLeft"));
    expect(navigate.mock.calls).toEqual([[1], [-1]]);
  });

  it("without siblings, Left/Right do nothing but are still consumed", () => {
    const fs = createPreviewFullscreen();
    fs.toggle();
    const right = key("ArrowRight");
    fs.handleKey(right);
    expect(fs.active).toBe(true);
    expect(fs.panX).toBe(0);
    expect(right.stopImmediatePropagation).toHaveBeenCalled();
  });

  it("pans with the arrows while zoomed instead of navigating", () => {
    const navigate = vi.fn();
    const fs = createPreviewFullscreen({ navigate });
    fs.toggle();
    fs.handleKey(key("+"));
    fs.handleKey(key("ArrowLeft"));
    fs.handleKey(key("ArrowUp"));
    expect(navigate).not.toHaveBeenCalled();
    expect([fs.panX, fs.panY]).toEqual([KEY_PAN_STEP, KEY_PAN_STEP]);
  });

  it("a subject that owns its keys keeps everything but Esc", () => {
    const fs = createPreviewFullscreen({ subjectOwnsKeys: () => true });
    fs.toggle();
    const plus = key("+");
    fs.handleKey(plus);
    expect(fs.zoom).toBe(1);
    expect(plus.preventDefault).not.toHaveBeenCalled();
    fs.handleKey(key("Escape"));
    expect(fs.active).toBe(false);
  });

  it("blocked keys (a modal is open) are left alone, Esc included", () => {
    const fs = createPreviewFullscreen({ keysBlocked: () => true });
    fs.toggle();
    fs.handleKey(key("Escape"));
    expect(fs.active).toBe(true);
  });

  it("wheel zooms only in fullscreen, at the cursor", () => {
    const fs = createPreviewFullscreen();
    fs.container = containerAtOrigin();
    const outside = wheel(-100, 50, 0);
    fs.wheel(outside);
    expect(fs.zoom).toBe(1);
    expect(outside.preventDefault).not.toHaveBeenCalled();

    fs.toggle();
    const up = wheel(-100, 50, 0);
    fs.wheel(up);
    expect(up.preventDefault).toHaveBeenCalled();
    expect(fs.zoom).toBeGreaterThan(1);
    // The point under the cursor (50, 0) stays put: pan = 50 - 50 * zoom.
    expect(fs.panX).toBeCloseTo(50 - 50 * fs.zoom);
    expect(fs.panY).toBeCloseTo(0);
  });

  it("dragging while zoomed pans, and its release does not leave fullscreen", () => {
    const fs = createPreviewFullscreen();
    fs.toggle();
    fs.handleKey(key("+"));
    fs.pointerDown(pointer(100, 100));
    expect(fs.panning).toBe(true);
    fs.pointerMove({ clientX: 130, clientY: 90 });
    fs.pointerUp();
    expect(fs.panning).toBe(false);
    expect([fs.panX, fs.panY]).toEqual([30, -10]);
    fs.click(click());
    expect(fs.active).toBe(true);
  });

  it("a drag release at fit zoom after zooming back is swallowed once, then clicks toggle", () => {
    const fs = createPreviewFullscreen();
    fs.toggle();
    fs.handleKey(key("+"));
    fs.pointerDown(pointer(0, 0));
    fs.pointerMove({ clientX: 40, clientY: 0 });
    fs.pointerUp();
    fs.handleKey(key("0"));
    fs.click(click()); // the drag's own click
    expect(fs.active).toBe(true);
    fs.click(click());
    expect(fs.active).toBe(false);
  });

  it("a click while zoomed stays fullscreen", () => {
    const fs = createPreviewFullscreen();
    fs.toggle();
    fs.handleKey(key("+"));
    fs.click(click());
    expect(fs.active).toBe(true);
  });

  it("does not pan at fit zoom or with a non-primary button", () => {
    const fs = createPreviewFullscreen();
    fs.toggle();
    fs.pointerDown(pointer(0, 0));
    expect(fs.panning).toBe(false);
    fs.handleKey(key("+"));
    fs.pointerDown(pointer(0, 0, 2));
    expect(fs.panning).toBe(false);
    fs.pointerMove({ clientX: 500, clientY: 500 });
    expect([fs.panX, fs.panY]).toEqual([0, 0]);
  });
});
