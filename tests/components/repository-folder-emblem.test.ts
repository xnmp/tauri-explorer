/**
 * Repository folders carry their Git emblem on the folder body, not as a
 * bottom-right corner badge: that corner is where Tiles draws the peek caret,
 * and the old badge collided with it (#1477). Geometry comes from the domain
 * seam; rendering is checked through Svelte's server renderer.
 */
import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import FileIcon from "$lib/components/FileIcon.svelte";
import { repositoryEmblem, TILE_CARET_INSET, type RepositoryEmblemSurface } from "$lib/domain/file-icon-identity";
import { THUMBNAIL_SIZE_CONFIG } from "$lib/domain/tile-layout";
import type { FileEntry } from "$lib/domain/file";
import type { IconPack } from "$lib/domain/icon-themes";

const repo: FileEntry = { name: "my-project", path: "/home/user/my-project", kind: "directory", size: 0, modified: "", is_git_repo: true };
const plain: FileEntry = { ...repo, name: "Documents", path: "/home/user/Documents", is_git_repo: false };
const box = (s: RepositoryEmblemSurface, size: "small" | "large") => {
  const e = repositoryEmblem(s, size);
  return { ...e, left: e.cx - e.r, right: e.cx + e.r, top: e.cy - e.r, bottom: e.cy + e.r };
};

/** Folder body (front panel) per surface, in viewBox units, from the drawn silhouettes. */
const BODIES: Array<[RepositoryEmblemSurface, "small" | "large", { left: number; right: number; top: number; bottom: number }]> = [
  ["folder", "small", { left: 3, right: 15, top: 6.5, bottom: 14.5 }],
  ["folder", "large", { left: 5, right: 43, top: 16.25, bottom: 43.75 }],
  ["catppuccin", "small", { left: 1.5, right: 40.5, top: 13.5, bottom: 40.5 }],
  ["catppuccin", "large", { left: 1.5, right: 40.5, top: 13.5, bottom: 40.5 }],
  ["thumbnail", "large", { left: 2, right: 46, top: 35, bottom: 45 }],
];

describe("repository folder emblem geometry", () => {
  it.each(BODIES)("%s/%s sits inside the folder body, horizontally centred on it", (surface, size, body) => {
    const e = box(surface, size);
    expect(e.left).toBeGreaterThanOrEqual(body.left);
    expect(e.right).toBeLessThanOrEqual(body.right);
    expect(e.top).toBeGreaterThanOrEqual(body.top);
    expect(e.bottom).toBeLessThanOrEqual(body.bottom);
    expect(Math.abs(e.cx - (body.left + body.right) / 2)).toBeLessThanOrEqual(0.5);
  });

  const presets = Object.entries(THUMBNAIL_SIZE_CONFIG).map(([name, c]) => [name, c.displaySize] as const);
  it.each(presets)("never reaches the Tiles peek caret at the %s preset (%ipx)", (_name, px) => {
    for (const surface of ["folder", "catppuccin", "thumbnail"] as const) {
      const e = box(surface, "large");
      const unit = e.viewBox / px;
      const caretLeft = (px - TILE_CARET_INSET.right) * unit;
      const caretTop = (px - TILE_CARET_INSET.bottom) * unit;
      // Overlap needs both axes; the emblem must be clear on at least one.
      expect(e.right < caretLeft || e.bottom < caretTop, `${surface} at ${px}px`).toBe(true);
    }
  });

  it("keeps compact emblems out of the bottom-right quadrant's corner", () => {
    for (const surface of ["folder", "catppuccin"] as const) {
      const e = box(surface, "small");
      expect(e.right, surface).toBeLessThan(e.viewBox * 0.86);
      expect(e.cx, surface).toBeLessThan(e.viewBox * 0.55);
    }
  });
});

function svgOf(entry: FileEntry, size: "small" | "large", theme: IconPack): string {
  return render(FileIcon as never, { props: { entry, size, theme } } as never).body;
}

describe("repository folder emblem rendering", () => {
  const packs: IconPack[] = ["material", "classic", "minimal", "catppuccin"];
  for (const theme of packs) for (const size of ["small", "large"] as const) {
    it(`${theme}/${size} draws a themed body emblem and no corner badge`, () => {
      const html = svgOf(repo, size, theme);
      expect(html).toContain("git-repo-emblem");
      expect(html).not.toContain("git-repo-badge");
      expect(html).not.toMatch(/<circle[^>]*class="git-repo/);

      const surface = theme === "catppuccin" ? "catppuccin" : "folder";
      const e = repositoryEmblem(surface, size);
      const plate = html.match(/<rect class="git-repo-emblem-plate"[^>]*>/)?.[0] ?? "";
      expect(plate).toContain(`rotate(45 ${e.cx} ${e.cy})`);
      expect(plate).toContain('fill="var(--icon-git-badge, #f05033)"');
      expect(html).toMatch(/class="git-repo-emblem-glyph"[^>]*stroke="var\(--icon-git-badge-glyph, #fff\)"/);
      expect(html).toContain(`translate(${e.cx} ${e.cy})`);
    });
  }

  it("leaves ordinary folders undecorated", () => {
    for (const theme of packs) expect(svgOf(plain, "large", theme)).not.toContain("git-repo-emblem");
  });
});
