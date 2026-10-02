import { describe, expect, it, vi } from "vitest";
import { createImageCropSession, croppedCopyName } from "$lib/state/image-crop-session";
import type { ImageCropCapture, ImageCropSave } from "$lib/api/image-crop";
import type { ApiResult } from "$lib/api/common";
import type { FileMutationReceipt } from "$lib/domain/file";

const capture = (path = "/image.png"): ImageCropCapture => ({ path, format: "PNG", dataUrl: "data:image/png;base64,AA==",
  revision: { digest: "a".repeat(64), size: 1, modifiedSeconds: 1, modifiedNanos: 0, identity: "original", readonly: false } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function fixture(overrides = {}) {
  const dependencies = {
    capture: vi.fn(async () => ({ ok: true, data: capture() } as const)),
    save: vi.fn(async (_request: ImageCropSave): Promise<ApiResult<FileMutationReceipt>> => ({ ok: true, data: { path: "/copy.png", entry: null } })),
    createUrl: vi.fn(() => "blob:owned"), revokeUrl: vi.fn(), changed: vi.fn(), saved: vi.fn(), ...overrides,
  };
  return { dependencies, session: createImageCropSession(dependencies) };
}
describe("image crop editor ownership", () => {
  it("closing a delayed capture cannot reopen the editor or create a URL", async () => {
    const pending = deferred<ApiResult<ImageCropCapture>>();
    const { session, dependencies } = fixture({ capture: () => pending.promise });
    const opening = session.open("/image.png", "image.png");
    session.close();
    pending.resolve({ ok: true, data: capture() });
    await opening;
    expect(session.state.phase).toBe("closed");
    expect(dependencies.createUrl).not.toHaveBeenCalled();
  });
  it("the latest opening owns its captured image", async () => {
    const first = deferred<ApiResult<ImageCropCapture>>();
    const second = deferred<ApiResult<ImageCropCapture>>();
    const { session } = fixture({ capture: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise) });
    const old = session.open("/old.png", "old.png");
    const next = session.open("/new.png", "new.png");
    second.resolve({ ok: true, data: capture("/new.png") }); await next;
    first.resolve({ ok: true, data: capture("/old.png") }); await old;
    expect(session.state.capture?.path).toBe("/new.png");
    expect(session.state.name).toBe("new.png");
  });
  it("retains three other edges and clamps an empty selection to one pixel", async () => {
    const { session } = fixture(); await session.open("/image.png", "image.png");
    session.loaded({ width: 100, height: 80 }); session.edge("left", 200);
    expect(session.state.rect).toEqual({ left: 99, top: 0, right: 100, bottom: 80 });
    session.edge("bottom", -1);
    expect(session.state.rect).toEqual({ left: 99, top: 0, right: 100, bottom: 1 });
    session.edge("top", NaN); expect(session.state.rect?.top).toBe(0);
    session.reset(); expect(session.state.rect).toEqual({ left: 0, top: 0, right: 100, bottom: 80 });
  });
  it("a duplicate save or reopening cannot redirect accepted work", async () => {
    const pending = deferred<ApiResult<FileMutationReceipt>>();
    const { session, dependencies } = fixture({ save: vi.fn(() => pending.promise) });
    await session.open("/image.png", "image.png"); session.loaded({ width: 100, height: 80 });
    session.edge("left", 10);
    const saving = session.save({ kind: "copy", name: "copy.png" });
    session.edge("left", 30); session.close(); await session.open("/other.png", "other.png");
    await session.save({ kind: "replace" });
    expect(dependencies.save).toHaveBeenCalledTimes(1);
    expect(dependencies.save.mock.calls[0][0]).toMatchObject({ path: "/image.png", rect: { left: 10 }, destination: { kind: "copy", name: "copy.png" } });
    pending.resolve({ ok: true, data: { path: "/copy.png", entry: null } }); await saving;
    expect(session.state.phase).toBe("closed");
    expect(dependencies.saved).toHaveBeenCalledTimes(1);
    expect(dependencies.revokeUrl).toHaveBeenCalledWith("blob:owned");
  });
  it("publishes a completed save after unmount without reviving the editor", async () => {
    const pending = deferred<ApiResult<FileMutationReceipt>>();
    const { session, dependencies } = fixture({ save: () => pending.promise });
    await session.open("/image.png", "image.png"); session.loaded({ width: 100, height: 80 });
    const saving = session.save({ kind: "replace" }); session.dispose();
    pending.resolve({ ok: true, data: { path: "/image.png", entry: null }, warning: "retained" }); await saving;
    expect(session.state.phase).toBe("closed");
    expect(dependencies.saved).toHaveBeenCalledWith({ path: "/image.png", entry: null }, "retained");
    expect(dependencies.revokeUrl).toHaveBeenCalledTimes(1);
  });
  it("save errors retain the crop for review and never report success", async () => {
    const { session, dependencies } = fixture({ save: async () => ({ ok: false, error: "Copy already exists" } as const) });
    await session.open("/image.png", "image.png"); session.loaded({ width: 100, height: 80 }); session.edge("top", 3);
    await session.save({ kind: "copy", name: "copy.png" });
    expect(session.state.phase).toBe("editing"); expect(session.state.error).toBe("Copy already exists");
    expect(session.state.rect?.top).toBe(3); expect(dependencies.saved).not.toHaveBeenCalled();
  });
  it("cannot save before valid image dimensions have loaded", async () => {
    const { session, dependencies } = fixture(); await session.open("/image.png", "image.png");
    session.loaded({ width: 0, height: 80 }); await session.save({ kind: "replace" });
    expect(dependencies.save).not.toHaveBeenCalled(); expect(session.state.error).toContain("invalid dimensions");
  });
  it("generates a separate filename while retaining extension", () => {
    expect(croppedCopyName("photo.avif")).toBe("photo - Cropped.avif");
    expect(croppedCopyName(".image")).toBe(".image - Cropped");
  });
});
