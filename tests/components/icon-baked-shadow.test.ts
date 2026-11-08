/**
 * Built-in icons carry a static, baked shadow instead of a CSS filter (#1532).
 * `filter: drop-shadow(...)` was re-rasterized by WebKitGTK for every visible
 * tile on every scroll frame. Rendering is checked through Svelte's server
 * renderer; the browser guard (computed `filter: none` in every view mode)
 * lives in e2e/icon-shadow-filter.spec.ts.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { render } from "svelte/server";
import FileIcon from "$lib/components/FileIcon.svelte";
import { largeFileArt } from "$lib/components/icons/large-file-art.svelte";
import type { FileEntry } from "$lib/domain/file";
import type { IconPack } from "$lib/domain/icon-themes";

const entry = (name: string, kind: FileEntry["kind"] = "file"): FileEntry =>
  ({ name, path: `/p/${name}`, kind, size: 1, modified: "" });
const html = (e: FileEntry, size: "small" | "large", theme: IconPack = "classic") =>
  render(FileIcon as never, { props: { entry: e, size, theme } } as never).body;
const shadows = (out: string) => out.match(/class="baked-icon-shadow[^"]*"/g)?.length ?? 0;

beforeAll(async () => {
  largeFileArt();
  await vi.waitFor(() => expect(largeFileArt()).toBeDefined());
});

describe("baked icon shadow", () => {
  const files = ["notes.txt", "photo.png", "files.zip", "main.c", "song.mp3", "app.exe", "lib.rs", "unknown.xyz", "App.tsx", "script.py", "index.html", "movie.mp4"];

  for (const name of files) {
    it(`${name}: large artwork draws one offset shadow copy beneath the glyph`, () => {
      const out = html(entry(name), "large");
      expect(shadows(out)).toBe(1);
      // The copy precedes the glyph inside the same <svg>, so it paints underneath.
      expect(out).toMatch(/<svg[^>]*>(<!--[^]*?-->)?\s*<g class="baked-icon-shadow[^"]*" transform="translate\(0 [\d.]+\)">/);
    });
  }

  it("the classic large folder carries the shadow; other packs and 16px rows do not show one", () => {
    expect(shadows(html(entry("Folder", "directory"), "large", "classic"))).toBe(1);
    for (const theme of ["material", "minimal"] as const) expect(shadows(html(entry("Folder", "directory"), "large", theme))).toBe(0);
    expect(shadows(html(entry("Folder", "directory"), "small", "classic"))).toBe(0);
    // Category artwork at 16px has no shadow copy at all.
    for (const name of ["notes.txt", "photo.png", "files.zip", "unknown.xyz"]) expect(shadows(html(entry(name), "small"))).toBe(0);
  });

  it("no built-in icon component styles a CSS filter", () => {
    const dir = "src/lib/components";
    const sources = [
      ...["FileIcon", "FolderIcon", "MaterialFileIcon", "CatppuccinFileIcon", "FolderDecoration", "NamedFolderIcon"].map((n) => join(dir, `${n}.svelte`)),
      ...readdirSync(join(dir, "icons")).filter((f) => f.endsWith(".svelte")).map((f) => join(dir, "icons", f)),
    ];
    for (const file of sources) {
      const style = readFileSync(file, "utf8").match(/<style[^>]*>([^]*?)<\/style>/)?.[1] ?? "";
      expect(style, file).not.toMatch(/(^|[\s;{])filter\s*:/);
      expect(style, file).not.toContain("drop-shadow");
    }
  });
});
