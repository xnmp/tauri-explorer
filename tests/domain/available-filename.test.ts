/**
 * findAvailableFilename (#278): collision-free derived output names.
 * Behavior contract shared by the nano-banana and upscale dialogs.
 */
import { describe, it, expect } from "vitest";
import { findAvailableFilename } from "$lib/domain/available-filename";

/** pathsExist stub: the given set of taken paths exists. */
function taken(...paths: string[]) {
  const set = new Set(paths);
  return async (candidates: string[]) => candidates.map((c) => set.has(c));
}

describe("findAvailableFilename", () => {
  it("returns the plain suffixed name when free", async () => {
    const name = await findAvailableFilename("/pics", "photo.png", "_upscaled", taken());
    expect(name).toBe("photo_upscaled.png");
  });

  it("numbers the name when earlier candidates are taken", async () => {
    const name = await findAvailableFilename(
      "/pics",
      "photo.png",
      "_upscaled",
      taken("/pics/photo_upscaled.png", "/pics/photo_upscaled_2.png"),
    );
    expect(name).toBe("photo_upscaled_3.png");
  });

  it("keeps multi-dot names intact and suffixes before the final extension", async () => {
    const name = await findAvailableFilename("/d", "archive.tar.gz", "_edit", taken());
    expect(name).toBe("archive.tar_edit.gz");
  });

  it("treats a dotfile as extensionless and falls back to .png", async () => {
    const name = await findAvailableFilename("/d", ".hidden", "_edit", taken());
    expect(name).toBe(".hidden_edit.png");
  });

  it("falls back to .png for names without an extension", async () => {
    const name = await findAvailableFilename("/d", "scan", "_edit", taken());
    expect(name).toBe("scan_edit.png");
  });

  it("falls back to a timestamped name when all 20 candidates collide", async () => {
    const all = ["/d/x_edit.png"];
    for (let i = 2; i <= 20; i++) all.push(`/d/x_edit_${i}.png`);
    const name = await findAvailableFilename("/d", "x.png", "_edit", taken(...all));
    expect(name).toMatch(/^x_edit_\d{10,}\.png$/);
  });
});
