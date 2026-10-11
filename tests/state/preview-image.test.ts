/**
 * Preview image loading (#1033, #1054): file images and plugin Preview
 * targets share it, so a path the asset protocol cannot serve — a plugin temp
 * directory outside its scope, a cloud placeholder — still loads through the
 * backend read. With rendition options a large image shows a display-sized
 * rendition, and every rendition failure falls back to the original.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { isTauri, readImageAsBlobUrl, getPreviewImage, convertFileSrc } = vi.hoisted(() => ({
  isTauri: vi.fn(),
  readImageAsBlobUrl: vi.fn(),
  getPreviewImage: vi.fn(),
  convertFileSrc: vi.fn((path: string) => `asset://localhost${path}`),
}));
vi.mock("$lib/api/common", () => ({ isTauri }));
vi.mock("$lib/api/files", () => ({ readImageAsBlobUrl }));
vi.mock("$lib/api/thumbnails", () => ({ getPreviewImage }));
vi.mock("$lib/api/frontend-log", () => ({ logFrontendDiagnostic: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc }));

import { loadPreviewImage, type PreviewImageOwner } from "$lib/state/preview-image";
import { createLatestOnlyRunner } from "$lib/domain/latest-only";

/** Image stub: decoding fails for URLs in `undecodable`; records every decode. */
const undecodable = new Set<string>();
const decoded: string[] = [];
class FakeImage {
  src = "";
  decode(): Promise<void> {
    decoded.push(this.src);
    return [...undecodable].some((prefix) => this.src.startsWith(prefix))
      ? Promise.reject(new Error("decode failed"))
      : Promise.resolve();
  }
}

const RENDITION = "/cache/thumbnails/abc.preview.jpg";
const withRendition = { rendition: { maxEdge: 2048 } };

function owner(current = () => true) {
  const adopted: string[] = [];
  const released: string[] = [];
  const value: PreviewImageOwner = {
    isCurrent: current,
    adoptBlob: (url) => { adopted.push(url); return current(); },
    releaseBlob: (url) => { released.push(url); },
  };
  return { value, adopted, released };
}

beforeEach(() => {
  vi.clearAllMocks();
  undecodable.clear();
  decoded.length = 0;
  vi.stubGlobal("Image", FakeImage);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("loadPreviewImage", () => {
  it("in Tauri, streams through the asset protocol with a cache-busting version", async () => {
    isTauri.mockReturnValue(true);
    const result = await loadPreviewImage("/home/u/a b.png", "12-34", owner().value);
    expect(result).toEqual({ status: "ready", url: "asset://localhost/home/u/a b.png?v=12-34", viaBackend: false, resolution: "original" });
    expect(readImageAsBlobUrl).not.toHaveBeenCalled();
  });

  it("encodes the cache-busting version", async () => {
    isTauri.mockReturnValue(true);
    const result = await loadPreviewImage("/p.png", "id:42&x", owner().value);
    expect(result.status === "ready" && result.url).toBe("asset://localhost/p.png?v=id%3A42%26x");
  });

  it("falls back to the backend read when the asset protocol cannot serve the path", async () => {
    isTauri.mockReturnValue(true);
    undecodable.add("asset://");
    readImageAsBlobUrl.mockResolvedValue({ ok: true, data: "blob:full" });
    const o = owner();
    const result = await loadPreviewImage("/var/folders/T/plugin/out.png", "v", o.value);
    expect(readImageAsBlobUrl).toHaveBeenCalledWith("/var/folders/T/plugin/out.png");
    expect(result).toEqual({ status: "ready", url: "blob:full", viaBackend: true, resolution: "original" });
    expect(o.adopted).toEqual(["blob:full"]);
  });

  it("outside Tauri, reads through the backend only", async () => {
    isTauri.mockReturnValue(false);
    readImageAsBlobUrl.mockResolvedValue({ ok: true, data: "blob:mock" });
    const result = await loadPreviewImage("/tmp/x.png", "v", owner().value);
    expect(convertFileSrc).not.toHaveBeenCalled();
    expect(result).toEqual({ status: "ready", url: "blob:mock", viaBackend: true, resolution: "original" });
  });

  it("fails when the backend read fails", async () => {
    isTauri.mockReturnValue(false);
    readImageAsBlobUrl.mockResolvedValue({ ok: false, error: "Not found" });
    expect(await loadPreviewImage("/missing.png", "v", owner().value)).toEqual({ status: "failed" });
  });

  it("releases an adopted blob that does not decode", async () => {
    isTauri.mockReturnValue(false);
    undecodable.add("blob:");
    readImageAsBlobUrl.mockResolvedValue({ ok: true, data: "blob:corrupt" });
    const o = owner();
    expect(await loadPreviewImage("/c.png", "v", o.value)).toEqual({ status: "failed" });
    expect(o.released).toEqual(["blob:corrupt"]);
  });

  it("a load superseded during the backend read hands its blob back and shows nothing", async () => {
    isTauri.mockReturnValue(false);
    let current = true;
    readImageAsBlobUrl.mockImplementation(async () => {
      current = false;
      return { ok: true, data: "blob:late" };
    });
    const o = owner(() => current);
    expect(await loadPreviewImage("/late.png", "v", o.value)).toEqual({ status: "stale" });
    expect(o.adopted).toEqual(["blob:late"]);
  });

  it("a load superseded before the asset decode does not fall back", async () => {
    isTauri.mockReturnValue(true);
    const o = owner(() => false);
    expect(await loadPreviewImage("/s.png", "v", o.value)).toEqual({ status: "stale" });
    expect(readImageAsBlobUrl).not.toHaveBeenCalled();
  });

  it("without rendition options (plugin targets, fullscreen) never asks for a rendition", async () => {
    isTauri.mockReturnValue(true);
    await loadPreviewImage("/p.png", "v", owner().value);
    expect(getPreviewImage).not.toHaveBeenCalled();
  });
});

describe("loadPreviewImage with a rendition", () => {
  it("in Tauri, shows the backend's rendition through the asset protocol and never decodes the original", async () => {
    isTauri.mockReturnValue(true);
    getPreviewImage.mockResolvedValue({ ok: true, data: { kind: "rendition", path: RENDITION } });
    const result = await loadPreviewImage("/w/huge.png", "1-2", owner().value, withRendition);

    expect(getPreviewImage).toHaveBeenCalledWith("/w/huge.png", 2048);
    expect(result).toEqual({ status: "ready", url: `asset://localhost${RENDITION}?v=1-2`, viaBackend: false, resolution: "rendition" });
    expect(decoded).toEqual([`asset://localhost${RENDITION}?v=1-2`]);
  });

  it("loads the original when the backend says the image is its own original", async () => {
    isTauri.mockReturnValue(true);
    getPreviewImage.mockResolvedValue({ ok: true, data: { kind: "original" } });
    const result = await loadPreviewImage("/w/small.png", "v", owner().value, withRendition);
    expect(result).toEqual({ status: "ready", url: "asset://localhost/w/small.png?v=v", viaBackend: false, resolution: "original" });
  });

  it("falls back to the original when the rendition request fails", async () => {
    isTauri.mockReturnValue(true);
    getPreviewImage.mockResolvedValue({ ok: false, error: "Failed to decode image" });
    const result = await loadPreviewImage("/w/odd.png", "v", owner().value, withRendition);
    expect(result).toMatchObject({ status: "ready", url: "asset://localhost/w/odd.png?v=v", resolution: "original" });
  });

  it("falls back to the original when the rendition file cannot be shown", async () => {
    isTauri.mockReturnValue(true);
    undecodable.add(`asset://localhost${RENDITION}`);
    getPreviewImage.mockResolvedValue({ ok: true, data: { kind: "rendition", path: RENDITION } });
    const result = await loadPreviewImage("/w/huge.png", "v", owner().value, withRendition);
    expect(result).toMatchObject({ status: "ready", url: "asset://localhost/w/huge.png?v=v", resolution: "original" });
    expect(readImageAsBlobUrl).not.toHaveBeenCalled();
  });

  it("keeps the original's backend fallback after a failed rendition", async () => {
    isTauri.mockReturnValue(true);
    undecodable.add("asset://");
    getPreviewImage.mockResolvedValue({ ok: true, data: { kind: "rendition", path: RENDITION } });
    readImageAsBlobUrl.mockResolvedValue({ ok: true, data: "blob:full" });
    const result = await loadPreviewImage("/cloud/huge.png", "v", owner().value, withRendition);
    expect(readImageAsBlobUrl).toHaveBeenCalledWith("/cloud/huge.png");
    expect(result).toEqual({ status: "ready", url: "blob:full", viaBackend: true, resolution: "original" });
  });

  it("a load superseded during the rendition request shows nothing and loads nothing else", async () => {
    isTauri.mockReturnValue(true);
    let current = true;
    getPreviewImage.mockImplementation(async () => {
      current = false;
      return { ok: true, data: { kind: "rendition", path: RENDITION } };
    });
    const result = await loadPreviewImage("/w/huge.png", "v", owner(() => current).value, withRendition);
    expect(result).toEqual({ status: "stale" });
    expect(decoded).toEqual([]);
  });

  it("selections skipped while a rendition is generated never reach the backend", async () => {
    isTauri.mockReturnValue(true);
    const runner = createLatestOnlyRunner();
    let finishFirst!: () => void;
    getPreviewImage.mockImplementation((path: string) =>
      path === "/w/1.png"
        ? new Promise((resolve) => { finishFirst = () => resolve({ ok: true, data: { kind: "rendition", path: RENDITION } }); })
        : Promise.resolve({ ok: true, data: { kind: "original" } }),
    );
    let selected = "/w/1.png";
    const load = (path: string) =>
      loadPreviewImage(path, "v", owner(() => selected === path).value, { rendition: { maxEdge: 2048, runner } });

    const loads = ["/w/1.png", "/w/2.png", "/w/3.png", "/w/4.png"].map((path) => {
      selected = path;
      return load(path);
    });
    // The runner starts the first request on a microtask.
    await vi.waitFor(() => expect(getPreviewImage).toHaveBeenCalledTimes(1));
    finishFirst();
    const results = await Promise.all(loads);

    expect(getPreviewImage.mock.calls.map(([path]) => path)).toEqual(["/w/1.png", "/w/4.png"]);
    expect(results.map((r) => r.status)).toEqual(["stale", "stale", "stale", "ready"]);
  });

  it("outside Tauri, reads a rendition through the backend", async () => {
    isTauri.mockReturnValue(false);
    getPreviewImage.mockResolvedValue({ ok: true, data: { kind: "rendition", path: RENDITION } });
    readImageAsBlobUrl.mockResolvedValue({ ok: true, data: "blob:rendition" });
    const result = await loadPreviewImage("/w/huge.png", "v", owner().value, withRendition);
    expect(readImageAsBlobUrl).toHaveBeenCalledWith(RENDITION);
    expect(result).toEqual({ status: "ready", url: "blob:rendition", viaBackend: true, resolution: "rendition" });
  });
});
