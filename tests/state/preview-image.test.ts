/**
 * Full-resolution Preview image loading (#1033): file images and plugin
 * Preview targets share it, so a path the asset protocol cannot serve — a
 * plugin temp directory outside its scope, a cloud placeholder — still loads
 * through the backend read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { isTauri, readImageAsBlobUrl, convertFileSrc } = vi.hoisted(() => ({
  isTauri: vi.fn(),
  readImageAsBlobUrl: vi.fn(),
  convertFileSrc: vi.fn((path: string) => `asset://localhost${path}`),
}));
vi.mock("$lib/api/common", () => ({ isTauri }));
vi.mock("$lib/api/files", () => ({ readImageAsBlobUrl }));
vi.mock("$lib/api/frontend-log", () => ({ logFrontendDiagnostic: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc }));

import { loadPreviewImage, type PreviewImageOwner } from "$lib/state/preview-image";

/** Image stub: decoding fails for URLs in `undecodable`. */
const undecodable = new Set<string>();
class FakeImage {
  src = "";
  decode(): Promise<void> {
    return [...undecodable].some((prefix) => this.src.startsWith(prefix))
      ? Promise.reject(new Error("decode failed"))
      : Promise.resolve();
  }
}

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
    expect(result).toEqual({ status: "ready", url: "asset://localhost/home/u/a b.png?v=12-34", viaBackend: false });
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
    expect(result).toEqual({ status: "ready", url: "blob:full", viaBackend: true });
    expect(o.adopted).toEqual(["blob:full"]);
  });

  it("outside Tauri, reads through the backend only", async () => {
    isTauri.mockReturnValue(false);
    readImageAsBlobUrl.mockResolvedValue({ ok: true, data: "blob:mock" });
    const result = await loadPreviewImage("/tmp/x.png", "v", owner().value);
    expect(convertFileSrc).not.toHaveBeenCalled();
    expect(result).toEqual({ status: "ready", url: "blob:mock", viaBackend: true });
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
});
