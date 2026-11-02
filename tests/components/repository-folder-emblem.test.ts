/**
 * Repository folders are drawn the way each icon pack draws a special folder
 * (#1490): the whole folder takes the Git colour and carries a branch glyph
 * in the pack's own idiom (knocked out of a solid Material/Classic folder,
 * stroked at the outline weight in Minimal/Catppuccin). The glyph stays on the
 * folder body, clear of the bottom-right corner where Tiles draws the peek
 * caret (#1477). Geometry and style selection come from the domain seam;
 * rendering is checked through Svelte's server renderer.
 */
import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import FileIcon from "$lib/components/FileIcon.svelte";
import {
  repositoryEmblem, repositoryEmblemBounds, repositoryFolderStyle, repositoryGlyphPath, REPOSITORY_GLYPH_NODES, TILE_CARET_INSET,
  type RepositoryEmblemSurface, type RepositoryFolderStyle,
} from "$lib/domain/file-icon-identity";
import { THUMBNAIL_SIZE_CONFIG } from "$lib/domain/tile-layout";
import type { FileEntry } from "$lib/domain/file";
import type { IconPack } from "$lib/domain/icon-themes";

const repo: FileEntry = { name: "my-project", path: "/home/user/my-project", kind: "directory", size: 0, modified: "", is_git_repo: true };
const plain: FileEntry = { ...repo, name: "Documents", path: "/home/user/Documents", is_git_repo: false };
const packs: IconPack[] = ["material", "classic", "minimal", "catppuccin"];
const GIT_TINT = "var(--icon-git-badge, #f05033)";
const KNOCKOUT = "var(--icon-git-badge-glyph, var(--background-solid, #fff))";

describe("repository folder style per icon pack", () => {
  it("solid packs knock the glyph out of a Git-coloured folder; outline packs stroke it", () => {
    expect(Object.fromEntries(packs.map((p) => [p, repositoryFolderStyle(p)]))).toEqual({
      material: "filled", classic: "filled", minimal: "outline", catppuccin: "outline",
    });
  });
});

/** Folder front panel interior per surface/style, in viewBox units, from the drawn silhouettes (minus outline strokes). */
const BODIES: Array<[RepositoryEmblemSurface, "small" | "large", RepositoryFolderStyle, { left: number; right: number; top: number; bottom: number }]> = [
  ["folder", "small", "filled", { left: 2.5, right: 15.5, top: 6.5, bottom: 14.5 }],
  ["folder", "large", "filled", { left: 2, right: 46, top: 16.25, bottom: 45 }],
  ["folder", "small", "outline", { left: 3.625, right: 14.375, top: 7.125, bottom: 13.875 }],
  ["folder", "large", "outline", { left: 5.75, right: 42.25, top: 15.75, bottom: 43 }],
  ["catppuccin", "small", "outline", { left: 3, right: 39, top: 15, bottom: 39 }],
  ["catppuccin", "large", "outline", { left: 3, right: 39, top: 15, bottom: 39 }],
  ["thumbnail", "large", "filled", { left: 2, right: 46, top: 38.75, bottom: 45 }],
  ["thumbnail", "large", "outline", { left: 2.75, right: 45.25, top: 38.75, bottom: 44.25 }],
];

describe("repository glyph geometry", () => {
  it.each(BODIES)("%s/%s/%s sits inside the folder body, horizontally centred on it", (surface, size, style, body) => {
    const e = repositoryEmblem(surface, size, style);
    const b = repositoryEmblemBounds(e);
    expect(b.left).toBeGreaterThanOrEqual(body.left);
    expect(b.right).toBeLessThanOrEqual(body.right);
    expect(b.top).toBeGreaterThanOrEqual(body.top);
    expect(b.bottom).toBeLessThanOrEqual(body.bottom);
    expect(Math.abs((b.left + b.right) / 2 - (body.left + body.right) / 2)).toBeLessThanOrEqual(0.5);
  });

  it("matches each pack's stroke weight", () => {
    // Minimal outlines are 1.25 (18-unit) / 1.5 (48-unit); Catppuccin's sprite
    // strokes 1 of 16 units (3 overlay units); the Material sprite's Git mark is 3.
    expect(repositoryEmblem("folder", "small", "outline").stroke).toBeLessThanOrEqual(1.25);
    expect(repositoryEmblem("folder", "large", "outline").stroke).toBe(1.5);
    expect(repositoryEmblem("catppuccin", "small", "outline").stroke).toBe(3);
    expect(repositoryEmblem("catppuccin", "large", "outline").stroke).toBe(3);
    expect(repositoryEmblem("folder", "large", "filled").stroke).toBe(3);
  });

  it("opens ring nodes by stopping lines at their edges", () => {
    const ringed = repositoryEmblem("folder", "large", "outline");
    expect(ringed.ring).toBe(true);
    const gap = ringed.dot / ringed.unit;
    expect(repositoryGlyphPath(ringed)).toMatch(new RegExp(`^M-4 ${-6 + gap}V${6 - gap}M4 ${gap - 3}C`));
    expect(repositoryGlyphPath(repositoryEmblem("folder", "large", "filled"))).toMatch(/^M-4 -6V6M4 -3C/);
  });

  const presets = Object.entries(THUMBNAIL_SIZE_CONFIG).map(([name, c]) => [name, c.displaySize] as const);
  it.each(presets)("never reaches the Tiles peek caret at the %s preset (%ipx)", (_name, px) => {
    for (const [surface, style] of [["folder", "filled"], ["folder", "outline"], ["catppuccin", "outline"], ["thumbnail", "filled"], ["thumbnail", "outline"]] as const) {
      const e = repositoryEmblem(surface, "large", style);
      const b = repositoryEmblemBounds(e);
      const unit = e.viewBox / px;
      const caretLeft = (px - TILE_CARET_INSET.right) * unit;
      const caretTop = (px - TILE_CARET_INSET.bottom) * unit;
      // Overlap needs both axes; the glyph must be clear on at least one.
      expect(b.right < caretLeft || b.bottom < caretTop, `${surface}/${style} at ${px}px`).toBe(true);
    }
  });

  it("keeps compact glyphs out of the bottom-right corner", () => {
    for (const [surface, style] of [["folder", "filled"], ["folder", "outline"], ["catppuccin", "outline"]] as const) {
      const e = repositoryEmblem(surface, "small", style);
      expect(repositoryEmblemBounds(e).right, surface).toBeLessThan(e.viewBox * 0.86);
      expect(e.cx, surface).toBeLessThan(e.viewBox * 0.55);
    }
  });
});

function svgOf(entry: FileEntry, size: "small" | "large", theme: IconPack): string {
  return render(FileIcon as never, { props: { entry, size, theme } } as never).body;
}

describe("repository folder rendering", () => {
  for (const theme of packs) for (const size of ["small", "large"] as const) {
    it(`${theme}/${size} tints the folder and draws the pack's glyph, with no plate or corner badge`, () => {
      const html = svgOf(repo, size, theme);
      const style = repositoryFolderStyle(theme);
      expect(html).not.toContain("git-repo-badge");
      expect(html).not.toContain("git-repo-emblem-plate");
      // The folder itself carries the Git colour.
      if (theme === "catppuccin") expect(html).toContain(`--folder-tint: ${GIT_TINT}`);
      else expect(html).toMatch(new RegExp(`class="[^"]*git-repo-folder[^"]*"[^>]*style="color: ${GIT_TINT.replace(/[()]/g, "\\$&")}`));

      const surface = theme === "catppuccin" ? "catppuccin" : "folder";
      const e = repositoryEmblem(surface, size, style);
      const group = html.match(/<g class="git-repo-emblem"[^>]*>/)?.[0] ?? "";
      expect(group).toContain(`translate(${e.cx} ${e.cy}) scale(${e.unit}) rotate(0)`);
      expect(group).toContain(`stroke="${style === "filled" ? KNOCKOUT : GIT_TINT}"`);
      const nodes = [...html.matchAll(/<circle cx="(-?\d+)" cy="(-?\d+)" r="([\d.]+)" fill="([^"]+)"/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3]), m[4]]);
      const fill = e.ring ? "none" : style === "filled" ? KNOCKOUT : GIT_TINT;
      expect(nodes).toEqual(REPOSITORY_GLYPH_NODES.map(([x, y]) => [x, y, e.r, fill]));
    });
  }

  it("leaves ordinary folders undecorated and in the folder colour", () => {
    for (const theme of packs) {
      const html = svgOf(plain, "large", theme);
      expect(html).not.toContain("git-repo-emblem");
      expect(html).not.toContain("--icon-git-badge");
    }
  });
});
