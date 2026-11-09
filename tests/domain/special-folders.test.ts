/**
 * Special folder icons (#1491): well-known directory names resolve to a kind,
 * and each icon pack badges that kind on its ordinary folder (#1527).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  getSpecialFolderKind,
  resolveSpecialFolderVariant,
  specialFolderBadgeBox,
  specialFolderHue,
  SPECIAL_FOLDER_KINDS,
} from "$lib/domain/special-folders";
import { TILE_CARET_INSET } from "$lib/domain/file-icon-identity";
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
  const PACKS: IconPack[] = ["material", "classic", "minimal", "catppuccin"];

  it("ignores files and repository/linked folders, which keep their emblem", () => {
    for (const pack of PACKS) {
      expect(resolveSpecialFolderVariant({ ...src, kind: "file" }, pack, "large")).toBeNull();
      expect(resolveSpecialFolderVariant(dir("src", { is_git_repo: true }), pack, "large")).toBeNull();
      expect(resolveSpecialFolderVariant(dir("src", { is_symlink: true }), pack, "small")).toBeNull();
      expect(resolveSpecialFolderVariant(dir("Folder"), pack, "small")).toBeNull();
    }
  });

  it("maps every kind to its own badge symbol in every pack (#1527)", () => {
    const names = [["src", "src"], ["e2e", "tests"], ["node_modules", "node"], [".github", "github"], ["build", "dist"], ["Downloads", "download"]] as const;
    for (const pack of PACKS) for (const size of ["small", "large"] as const) for (const [name, kind] of names) {
      const v = resolveSpecialFolderVariant(dir(name), pack, size)!;
      expect(v.kind, name).toBe(kind);
      expect(v.symbol).toBe(pack === "catppuccin" ? `folder-${kind}-glyph` : kind);
    }
  });

  it("never repaints the folder body: every pack draws a badge on the theme's surface", () => {
    for (const pack of PACKS) for (const size of ["small", "large"] as const) {
      const v = resolveSpecialFolderVariant(src, pack, size)!;
      expect(v).not.toHaveProperty("body");
      expect(v.fill).toBe("var(--background-solid, #fff)");
    }
  });

  it("Classic and Material tint the badge with the kind's hue, honouring a colour theme's file tint", () => {
    for (const pack of ["classic", "material"] as const) {
      const v = resolveSpecialFolderVariant(src, pack, "large")!;
      expect(v).toMatchObject({ kind: "src", sprite: "glyphs", symbol: "src" });
      expect(v.ink).toBe(`color-mix(in srgb, var(--icon-file-tint, ${specialFolderHue("src")}) 70%, var(--text-primary, #000))`);
      expect(v.outline).toBe(v.ink);
      expect(resolveSpecialFolderVariant(dir("tests"), pack, "large")!.ink).not.toBe(v.ink);
    }
    expect(resolveSpecialFolderVariant(src, "classic", "small")!.stroke).toBeGreaterThan(resolveSpecialFolderVariant(src, "classic", "large")!.stroke);
  });

  it("Minimal draws an outline badge in the folder's stroke colour", () => {
    expect(resolveSpecialFolderVariant(src, "minimal", "large")).toMatchObject({ sprite: "glyphs", ink: "currentColor", outline: "currentColor" });
  });

  it("Catppuccin keeps its plain folder and badges the upstream glyph in its own accent", () => {
    for (const size of ["small", "large"] as const) {
      const v = resolveSpecialFolderVariant(src, "catppuccin", size)!;
      expect(v).toMatchObject({ sprite: "catppuccin", symbol: "folder-src-glyph", outline: "var(--vscode-ctp-text)" });
      expect(v.ink).toBeUndefined();
      expect(v.box).toBe(specialFolderBadgeBox("catppuccin", size));
    }
  });

  it("ships artwork for every kind in both sprites", () => {
    const glyphs = readFileSync("src/lib/components/icons/folder-glyphs-sprite.svg", "utf8");
    const catppuccin = readFileSync("src/lib/components/icons/catppuccin-sprite.svg", "utf8");
    for (const kind of SPECIAL_FOLDER_KINDS) {
      expect(glyphs, kind).toContain(`<symbol id="${kind}"`);
      expect(catppuccin, kind).toContain(`<symbol id="folder-${kind}-glyph"`);
    }
  });
});

describe("special folder badge geometry (#1527)", () => {
  const boxes = (["folder", "catppuccin"] as const).flatMap((surface) =>
    (["small", "large"] as const).map((size) => [surface, size, specialFolderBadgeBox(surface, size)] as const));

  it.each(boxes)("%s/%s badge sits in the bottom-left corner, clear of the top and right edges", (_surface, _size, b) => {
    const half = b.ring / 2;
    const painted = { left: b.x - half, right: b.x + b.w + half, top: b.y - half, bottom: b.y + b.w + half };
    expect(painted.left).toBeGreaterThanOrEqual(0);
    expect(painted.bottom).toBeLessThanOrEqual(b.viewBox);
    expect(b.x + b.w / 2).toBeLessThan(b.viewBox / 2);
    expect(b.y + b.w / 2).toBeGreaterThan(b.viewBox / 2);
    // The Git badge/status letter (top-right) and symlink badge (top-left)
    // keep the top band; the peek caret keeps the right side.
    expect(painted.top / b.viewBox).toBeGreaterThanOrEqual(0.4);
    expect(painted.right / b.viewBox).toBeLessThanOrEqual(0.6);
  });

  it.each(boxes)("%s/%s glyph sits inside its backing", (_surface, _size, b) => {
    expect(b.glyph.w).toBeGreaterThan(0);
    expect(b.glyph.x).toBeGreaterThanOrEqual(b.x);
    expect(b.glyph.y).toBeGreaterThanOrEqual(b.y);
    expect(b.glyph.x + b.glyph.w).toBeLessThanOrEqual(b.x + b.w);
    expect(b.glyph.y + b.glyph.w).toBeLessThanOrEqual(b.y + b.w);
  });

  it("stays at least 8px across at 16px and 24px across at 64px", () => {
    for (const [, size, b] of boxes) expect((b.w / b.viewBox) * (size === "small" ? 16 : 64)).toBeGreaterThanOrEqual(size === "small" ? 8 : 24);
  });

  const presets = Object.entries(THUMBNAIL_SIZE_CONFIG).map(([name, c]) => [name, c.displaySize] as const);
  it.each(presets)("never reaches the Tiles peek caret at the %s preset (%ipx)", (_name, px) => {
    for (const surface of ["folder", "catppuccin"] as const) {
      const b = specialFolderBadgeBox(surface, "large");
      const unit = b.viewBox / px;
      const caretLeft = (px - TILE_CARET_INSET.right) * unit;
      expect(b.x + b.w + b.ring / 2, `${surface} at ${px}px`).toBeLessThan(caretLeft);
    }
  });
});

describe("Google Drive folders (#1551)", () => {
  it.each([
    "Google Drive", "GoogleDrive", "google-drive", "gdrive", "GDrive", "My Drive",
    // GVfs mount roots as listed under /run/user/<uid>/gvfs.
    "google-drive:host=gmail.com,user=someone", "google-drive:host=example.com",
  ])("%j → gdrive", (name) => {
    expect(getSpecialFolderKind(name)).toBe("gdrive");
  });

  it.each(["Drive", "drive", "google", "google-drive-backup", "gdrive2", "sftp:host=example.com", "google-drive:"])(
    "leaves %j an ordinary folder",
    (name) => {
      expect(getSpecialFolderKind(name)).toBeNull();
    },
  );

  it("draws a tri-colour drive glyph in Classic and Material, honouring a colour theme's file tint", () => {
    for (const pack of ["classic", "material"] as const) for (const size of ["small", "large"] as const) {
      const v = resolveSpecialFolderVariant(dir("Google Drive"), pack, size)!;
      expect(v).toMatchObject({ kind: "gdrive", sprite: "glyphs", symbol: "gdrive" });
      expect(v.palette).toHaveLength(3);
      expect(new Set(v.palette).size).toBe(3);
      for (const paint of v.palette!) expect(paint).toMatch(/^var\(--icon-file-tint, #[0-9a-f]{6}\)$/);
    }
  });

  it("stays monochrome in Minimal and uses Catppuccin's own accents there", () => {
    expect(resolveSpecialFolderVariant(dir("gdrive"), "minimal", "small")!.palette).toBeUndefined();
    const ctp = resolveSpecialFolderVariant(dir("gdrive"), "catppuccin", "small")!;
    expect(ctp).toMatchObject({ kind: "gdrive", symbol: "folder-gdrive-glyph" });
    expect(ctp.palette).toBeUndefined();
  });

  it("ordinary kinds carry no palette", () => {
    expect(resolveSpecialFolderVariant(dir("src"), "material", "small")!.palette).toBeUndefined();
  });

  it("the glyph sprite paints each stroke from the palette, falling back to the ink", () => {
    const glyphs = readFileSync("src/lib/components/icons/folder-glyphs-sprite.svg", "utf8");
    const symbol = glyphs.match(/<symbol id="gdrive"[\s\S]*?<\/symbol>/)?.[0] ?? "";
    for (const slot of ["a", "b", "c"]) expect(symbol).toContain(`var(--special-folder-glyph-${slot}, currentColor)`);
  });
});
