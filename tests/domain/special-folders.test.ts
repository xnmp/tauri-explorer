/**
 * Special folder icons (#1491): well-known directory names resolve to a kind,
 * and each icon pack gets its own native variant of that kind.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  getSpecialFolderKind,
  resolveSpecialFolderVariant,
  specialFolderGlyphBox,
  specialFolderHue,
  SPECIAL_FOLDER_KINDS,
} from "$lib/domain/special-folders";
import { repositoryEmblem, TILE_CARET_INSET } from "$lib/domain/file-icon-identity";
import { THUMBNAIL_SIZE_CONFIG } from "$lib/domain/tile-layout";
import type { FileEntry } from "$lib/domain/file";
import type { IconPack } from "$lib/domain/icon-themes";

const dir = (name: string, extra: Partial<FileEntry> = {}): FileEntry =>
  ({ name, path: `/p/${name}`, kind: "directory", size: 0, modified: "", ...extra });

describe("special folder names", () => {
  it.each([
    ["src", "src"], ["Source", "src"], ["SRC", "src"],
    ["lib", "lib"], ["tests", "tests"], ["test", "tests"], ["__tests__", "tests"], ["e2e", "tests"],
    ["docs", "docs"], ["Documents", "docs"], ["node_modules", "node"], [".git", "git"], [".github", "github"],
    [".vscode", "vscode"], ["config", "config"], ["scripts", "scripts"], ["assets", "assets"],
    ["images", "images"], ["img", "images"], ["Pictures", "images"], ["public", "public"],
    ["dist", "dist"], ["build", "dist"], ["out", "dist"], ["components", "components"],
    ["Downloads", "download"], ["Music", "audio"], ["Videos", "video"], ["@types", "types"],
  ] as const)("%s → %s", (name, kind) => {
    expect(getSpecialFolderKind(name)).toBe(kind);
  });

  it.each(["Folder", "my-project", "srcs", "src2", "", "tests-old", " src", "git"])("leaves %j an ordinary folder", (name) => {
    expect(getSpecialFolderKind(name)).toBeNull();
  });

  it("does not inherit Object prototype keys as names", () => {
    expect(getSpecialFolderKind("constructor")).toBeNull();
    expect(getSpecialFolderKind("__proto__")).toBeNull();
  });

  it("gives every kind a distinct-looking Material hue", () => {
    for (const kind of SPECIAL_FOLDER_KINDS) expect(specialFolderHue(kind)).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("per-pack variants", () => {
  const src = dir("src");

  it("ignores files and repository/linked folders, which keep their emblem", () => {
    const packs: IconPack[] = ["material", "classic", "minimal", "catppuccin"];
    for (const pack of packs) {
      expect(resolveSpecialFolderVariant({ ...src, kind: "file" }, pack, "large")).toBeNull();
      expect(resolveSpecialFolderVariant(dir("src", { is_git_repo: true }), pack, "large")).toBeNull();
      expect(resolveSpecialFolderVariant(dir("src", { is_symlink: true }), pack, "small")).toBeNull();
      expect(resolveSpecialFolderVariant(dir("Folder"), pack, "small")).toBeNull();
    }
  });

  it("Material recolours the folder per kind, honouring a colour theme's file tint", () => {
    const v = resolveSpecialFolderVariant(src, "material", "large")!;
    expect(v).toMatchObject({ kind: "src", sprite: "glyphs", symbol: "src", overlay: true });
    expect(v.body).toBe(`var(--icon-file-tint, ${specialFolderHue("src")})`);
    expect(v.ink).toBe(`color-mix(in srgb, ${v.body} 40%, #000)`);
    expect(resolveSpecialFolderVariant(dir("tests"), "material", "large")!.body).not.toBe(v.body);
  });

  it("Classic keeps the theme folder colour and draws a deeper shade of it", () => {
    const v = resolveSpecialFolderVariant(src, "classic", "small")!;
    expect(v).toMatchObject({ sprite: "glyphs", symbol: "src", overlay: true, stroke: 3 });
    expect(v.body).toBeUndefined();
    expect(v.ink).toContain("var(--icon-folder");
  });

  it("Minimal draws an outline glyph in the folder's stroke colour", () => {
    const v = resolveSpecialFolderVariant(src, "minimal", "large")!;
    expect(v).toMatchObject({ sprite: "glyphs", ink: "currentColor", overlay: true });
    expect(v.body).toBeUndefined();
  });

  it("Catppuccin uses the upstream composite when small and its glyph on the plain folder when large", () => {
    expect(resolveSpecialFolderVariant(src, "catppuccin", "small")).toMatchObject({ sprite: "catppuccin", symbol: "folder-src", overlay: false, x: 0, y: 0, w: 16 });
    expect(resolveSpecialFolderVariant(src, "catppuccin", "large")).toMatchObject({ sprite: "catppuccin", symbol: "folder-src-glyph", overlay: true });
  });

  it("ships artwork for every kind in both sprites", () => {
    const glyphs = readFileSync("src/lib/components/icons/folder-glyphs-sprite.svg", "utf8");
    const catppuccin = readFileSync("src/lib/components/icons/catppuccin-sprite.svg", "utf8");
    for (const kind of SPECIAL_FOLDER_KINDS) {
      expect(glyphs, kind).toContain(`<symbol id="${kind}"`);
      expect(catppuccin, kind).toContain(`<symbol id="folder-${kind}"`);
      expect(catppuccin, kind).toContain(`<symbol id="folder-${kind}-glyph"`);
    }
  });
});

describe("special folder glyph geometry", () => {
  const bodies = {
    small: { left: 2.5, right: 15.5, top: 6.5, bottom: 14.5 },
    large: { left: 2, right: 46, top: 16.25, bottom: 45 },
  };

  it.each(["small", "large"] as const)("folder/%s glyph sits on the front panel, centred like the repository emblem", (size) => {
    const b = specialFolderGlyphBox("folder", size);
    const body = bodies[size];
    // Glyph artwork keeps a 2.5-unit margin inside its 24-unit grid.
    const inset = (b.w * 2.5) / 24;
    expect(b.x + inset).toBeGreaterThanOrEqual(body.left);
    expect(b.x + b.w - inset).toBeLessThanOrEqual(body.right);
    expect(b.y + inset).toBeGreaterThanOrEqual(body.top);
    expect(b.y + b.w - inset).toBeLessThanOrEqual(body.bottom);
    expect(Math.abs(b.x + b.w / 2 - repositoryEmblem("folder", size).cx)).toBeLessThanOrEqual(0.5);
  });

  const presets = Object.entries(THUMBNAIL_SIZE_CONFIG).map(([name, c]) => [name, c.displaySize] as const);
  it.each(presets)("never reaches the Tiles peek caret at the %s preset (%ipx)", (_name, px) => {
    // Catppuccin's large glyph-only symbol keeps its art in the 16-unit box's
    // lower-right quadrant (x 7.5–15.5, y 8.5–15.5), scaled by w/16.
    const cat = specialFolderGlyphBox("catppuccin", "large");
    const s = cat.w / 16;
    const folder = specialFolderGlyphBox("folder", "large");
    const boxes = [
      { viewBox: folder.viewBox, right: folder.x + folder.w, bottom: folder.y + folder.w },
      { viewBox: cat.viewBox, right: cat.x + 15.5 * s, bottom: cat.y + 15.5 * s },
    ];
    for (const b of boxes) {
      const unit = b.viewBox / px;
      const caretLeft = (px - TILE_CARET_INSET.right) * unit;
      const caretTop = (px - TILE_CARET_INSET.bottom) * unit;
      expect(b.right < caretLeft || b.bottom < caretTop, `${b.viewBox}-unit glyph at ${px}px`).toBe(true);
    }
  });
});
