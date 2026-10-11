/**
 * Full resolution on demand (#1054): the original of the shown rendition is
 * loaded once, and only lands while that rendition is still on screen.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("$lib/api/common", () => ({ isTauri: () => true }));
vi.mock("$lib/api/files", () => ({ readImageAsBlobUrl: vi.fn() }));
vi.mock("$lib/api/thumbnails", () => ({ getPreviewImage: vi.fn() }));
vi.mock("$lib/api/frontend-log", () => ({ logFrontendDiagnostic: vi.fn() }));

import { createFullResolutionUpgrade, type ShownRendition } from "$lib/state/preview-resolution";
import type { PreviewImageLoad, PreviewImageOwner } from "$lib/state/preview-image";

const owner = (current = () => true): PreviewImageOwner => ({
  isCurrent: current,
  adoptBlob: () => current(),
  releaseBlob: () => {},
});

const always = () => true;

const ready = (url: string): PreviewImageLoad => ({ status: "ready", url, viaBackend: false, resolution: "original" });

function rendition(path = "/w/huge.png", current?: () => boolean): ShownRendition {
  return { path, cacheBust: "1-2-0", owner: owner(current) };
}

describe("createFullResolutionUpgrade", () => {
  it("loads the shown rendition's original, with its cache-bust and owner, and hands it back", async () => {
    const load = vi.fn(async () => ready("asset://huge.png?v=1-2-0"));
    const upgrade = createFullResolutionUpgrade(load);
    const shown = rendition();
    upgrade.showing(shown);

    expect(await upgrade.upgrade(always)).toEqual(ready("asset://huge.png?v=1-2-0"));
    // The original load gets no rendition options: it is the file itself.
    expect(load).toHaveBeenCalledWith("/w/huge.png", "1-2-0", shown.owner);
  });

  it("does nothing when no rendition is shown", async () => {
    const load = vi.fn(async () => ready("x"));
    const upgrade = createFullResolutionUpgrade(load);
    expect(await upgrade.upgrade(always)).toBeNull();
    upgrade.showing(rendition());
    upgrade.showing(null);
    expect(await upgrade.upgrade(always)).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it("loads once per shown rendition, however often the viewer asks (zoom steps)", async () => {
    let finish!: (image: PreviewImageLoad) => void;
    const load = vi.fn(() => new Promise<PreviewImageLoad>((resolve) => { finish = resolve; }));
    const upgrade = createFullResolutionUpgrade(load);
    upgrade.showing(rendition());

    const first = upgrade.upgrade(always);
    expect(await upgrade.upgrade(always)).toBeNull();
    finish(ready("full"));
    expect(await first).toEqual(ready("full"));
    expect(await upgrade.upgrade(always)).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("drops an original that finishes after the pane moved on to another image", async () => {
    let finish!: (image: PreviewImageLoad) => void;
    const load = vi.fn(() => new Promise<PreviewImageLoad>((resolve) => { finish = resolve; }));
    const upgrade = createFullResolutionUpgrade(load);
    upgrade.showing(rendition("/w/a.png"));

    const pending = upgrade.upgrade(always);
    upgrade.showing(rendition("/w/b.png"));
    finish(ready("full-a"));
    expect(await pending).toBeNull();
  });

  it("a failed original keeps the rendition and is not retried for it", async () => {
    const load = vi.fn(async (): Promise<PreviewImageLoad> => ({ status: "failed" }));
    const upgrade = createFullResolutionUpgrade(load);
    upgrade.showing(rendition());

    expect(await upgrade.upgrade(always)).toBeNull();
    expect(await upgrade.upgrade(always)).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("a stale original (its load superseded) shows nothing", async () => {
    const load = vi.fn(async (): Promise<PreviewImageLoad> => ({ status: "stale" }));
    const upgrade = createFullResolutionUpgrade(load);
    upgrade.showing(rendition("/w/a.png", () => false));
    expect(await upgrade.upgrade(always)).toBeNull();
  });

  it("a new rendition of the same file can be upgraded again", async () => {
    const load = vi.fn(async () => ready("full"));
    const upgrade = createFullResolutionUpgrade(load);
    upgrade.showing(rendition());
    await upgrade.upgrade(always);
    upgrade.showing(rendition());
    expect(await upgrade.upgrade(always)).toEqual(ready("full"));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("an original that finishes after fullscreen was left is dropped, and loads again next time", async () => {
    let wanted = true;
    const load = vi.fn(async () => {
      wanted = false; // The user leaves fullscreen while the original decodes.
      return ready("full");
    });
    const upgrade = createFullResolutionUpgrade(load);
    upgrade.showing(rendition());

    expect(await upgrade.upgrade(() => wanted)).toBeNull();
    wanted = true;
    load.mockImplementation(async () => ready("full"));
    expect(await upgrade.upgrade(() => wanted)).toEqual(ready("full"));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not start loading while full resolution is not wanted", async () => {
    const load = vi.fn(async () => ready("full"));
    const upgrade = createFullResolutionUpgrade(load);
    upgrade.showing(rendition());
    expect(await upgrade.upgrade(() => false)).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it("an original whose load stopped being current while it resolved never lands", async () => {
    let current = true;
    const load = vi.fn(async () => {
      current = false; // A newer file was selected.
      return ready("full-old");
    });
    const upgrade = createFullResolutionUpgrade(load);
    upgrade.showing(rendition("/w/old.png", () => current));
    expect(await upgrade.upgrade(always)).toBeNull();
  });
});
