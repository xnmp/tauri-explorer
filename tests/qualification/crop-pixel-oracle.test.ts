import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { compareCropPixels, observeCropPreview } from "../../e2e-tauri/crop-pixel-oracle";

class LoadedImage {
  static instances: LoadedImage[] = [];
  src = "";
  complete = false;
  naturalWidth = 2;
  naturalHeight = 2;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { LoadedImage.instances.push(this); }
  // Models a decode promise that never settles despite a load event.
  decode() { return new Promise<void>(() => {}); }
}
beforeEach(() => {
  vi.useFakeTimers();
  LoadedImage.instances = [];
  vi.stubGlobal("Image", LoadedImage);
  vi.stubGlobal("document", { createElement: () => ({
    width: 0, height: 0, getContext: () => ({
      drawImage: vi.fn(), clearRect: vi.fn(),
      getImageData: () => ({ data: new Uint8ClampedArray(16) }),
    }),
  }) });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("returns the measured result after image load even when decode never settles", async () => {
  const done = vi.fn();
  void compareCropPixels("source", "saved", false, false, [0, 0, 2, 2], done);
  LoadedImage.instances.forEach(image => image.onload?.());
  await vi.advanceTimersByTimeAsync(0);
  expect(done).toHaveBeenCalledOnce();
  expect(done.mock.calls[0][0]).toMatchObject({ size: [2, 2], maximumError: 0 });
  expect(vi.getTimerCount()).toBe(0);
});
it("returns an explicit error and releases both loads when an image fails", async () => {
  const done = vi.fn();
  void compareCropPixels("source", "saved", false, false, [0, 0, 2, 2], done);
  LoadedImage.instances[0].onerror?.();
  await vi.advanceTimersByTimeAsync(0);
  expect(done).toHaveBeenCalledWith({ error: expect.stringContaining("load") });
  expect(vi.getTimerCount()).toBe(0);
});
it("bounds a missing image event and reports failure rather than fabricating pixels", async () => {
  const done = vi.fn();
  void compareCropPixels("source", "saved", false, false, [0, 0, 2, 2], done);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(done).toHaveBeenCalledWith({ error: expect.stringContaining("Timed out") });
  expect(done).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it("observes intrinsic preview dimensions after load without waiting for decode", async () => {
  vi.stubGlobal("document", { querySelector: () => ({ complete: true, naturalWidth: 200, src: "saved" }) });
  const done = vi.fn();
  void observeCropPreview([2, 2], done);
  LoadedImage.instances[0].onload?.();
  await vi.advanceTimersByTimeAsync(0);
  expect(done).toHaveBeenCalledWith(true);
  expect(vi.getTimerCount()).toBe(0);
});
it("bounds a preview load without accepting missing dimensions", async () => {
  vi.stubGlobal("document", { querySelector: () => ({ complete: true, naturalWidth: 200, src: "saved" }) });
  const done = vi.fn();
  void observeCropPreview([2, 2], done);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(done).toHaveBeenCalledWith(false);
  expect(done).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
