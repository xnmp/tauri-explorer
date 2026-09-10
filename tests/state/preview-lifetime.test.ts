import { describe, expect, it, vi } from "vitest";
import { createPreviewLifetime } from "$lib/state/preview-lifetime";

describe("preview request lifetime", () => {
  it.each(["text", "image", "archive", "directory", "pdf"])(
    "rejects a delayed %s result after the same path changes revision",
    () => {
      const lifetime = createPreviewLifetime(vi.fn());
      const oldRequest = lifetime.begin("/same/file|10|20");
      const currentRequest = lifetime.begin("/same/file|11|21");

      expect(lifetime.isCurrent(oldRequest)).toBe(false);
      expect(lifetime.isCurrent(currentRequest)).toBe(true);
    },
  );

  it("releases stale and mounted blob URLs exactly once", () => {
    const revoke = vi.fn();
    const lifetime = createPreviewLifetime(revoke);
    const stale = lifetime.begin("/image.png|1|1");
    const current = lifetime.begin("/image.png|2|2");

    expect(lifetime.adoptBlob(stale, "blob:stale")).toBe(false);
    expect(lifetime.adoptBlob(current, "blob:current")).toBe(true);
    lifetime.dispose();
    lifetime.dispose();

    expect(revoke.mock.calls).toEqual([["blob:stale"], ["blob:current"]]);
    expect(lifetime.isCurrent(current)).toBe(false);
  });

  it("releases a failed current decode before adopting its replacement", () => {
    const revoke = vi.fn();
    const lifetime = createPreviewLifetime(revoke);
    const failed = lifetime.begin("/image.png|1|1");
    lifetime.adoptBlob(failed, "blob:failed");
    lifetime.releaseBlob(failed, "blob:failed");

    const replacement = lifetime.begin("/image.png|2|2");
    lifetime.adoptBlob(replacement, "blob:replacement");
    lifetime.dispose();

    expect(revoke.mock.calls).toEqual([
      ["blob:failed"],
      ["blob:replacement"],
    ]);
  });

  it("does not let a stale provider alias revoke the current owner's blob", () => {
    const revoke = vi.fn();
    const lifetime = createPreviewLifetime(revoke);
    const stale = lifetime.begin("/image.png|1|1");
    const current = lifetime.begin("/image.png|2|2");
    lifetime.adoptBlob(current, "blob:shared");

    expect(lifetime.adoptBlob(stale, "blob:shared")).toBe(false);
    lifetime.releaseBlob(stale, "blob:shared");
    expect(revoke).not.toHaveBeenCalled();

    lifetime.dispose();
    expect(revoke).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith("blob:shared");
  });
});
