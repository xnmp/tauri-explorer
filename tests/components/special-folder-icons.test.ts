/**
 * Special folder icons (#1491) render through every icon pack's own folder
 * once the lazy renderer has loaded, and never displace a repository or link
 * emblem. Rendering is checked through Svelte's server renderer.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { render } from "svelte/server";
import FileIcon from "$lib/components/FileIcon.svelte";
import { specialFolderArt } from "$lib/components/icons/special-folder-icons.svelte";
import type { FileEntry } from "$lib/domain/file";
import type { IconPack } from "$lib/domain/icon-themes";

const dir = (name: string, extra: Partial<FileEntry> = {}): FileEntry =>
  ({ name, path: `/p/${name}`, kind: "directory", size: 0, modified: "", ...extra });
const html = (entry: FileEntry, size: "small" | "large", theme: IconPack) =>
  render(FileIcon as never, { props: { entry, size, theme } } as never).body;

beforeAll(async () => {
  specialFolderArt();
  await vi.waitFor(() => expect(specialFolderArt()).toBeDefined());
});

describe("special folder icon rendering", () => {
  for (const theme of ["material", "classic", "minimal"] as const) for (const size of ["small", "large"] as const) {
    it(`${theme}/${size} badges the kind's glyph on the pack's unchanged folder (#1527)`, () => {
      const out = html(dir("SRC"), size, theme);
      expect(out).toContain('data-special-folder="src"');
      expect(out).toMatch(/<rect class="special-folder-badge-backing"/);
      expect(out).toMatch(/<use class="special-folder-glyph"[^>]*href="[^"]*folder-glyphs-sprite[^"]*#src"/);
      expect(out).toContain(`data-icon-theme="${theme}"`);
      // The folder keeps the theme's folder colour: same tint as a plain folder.
      const tint = /folder-icon[^>]*style="color: ([^;"]*)/;
      expect(out.match(tint)?.[1]).toBe("var(--icon-folder, #ffb900)");
      expect(out.match(tint)?.[1]).toBe(html(dir("Folder"), size, theme).match(tint)?.[1]);
      expect(out).not.toContain("special-folder-body");
    });
  }

  it("catppuccin keeps its plain folder and badges the upstream glyph at both sizes", () => {
    for (const size of ["small", "large"] as const) {
      const out = html(dir("tests"), size, "catppuccin");
      expect(out).toMatch(/<use href="[^"]*catppuccin-sprite[^"]*#folder"/);
      expect(out).toMatch(/<use class="special-folder-glyph"[^>]*href="[^"]*catppuccin-sprite[^"]*#folder-tests-glyph"/);
      expect(out).not.toContain("special-folder-composite");
    }
  });

  it("keeps ordinary folders plain", () => {
    for (const theme of ["material", "classic", "minimal", "catppuccin"] as const) {
      expect(html(dir("Folder"), "large", theme)).not.toContain("special-folder");
    }
  });

  it("lets a repository or linked special folder keep its emblem", () => {
    for (const theme of ["material", "classic", "minimal", "catppuccin"] as const) {
      const repo = html(dir("src", { is_git_repo: true }), "large", theme);
      expect(repo).toContain("git-repo-emblem");
      expect(repo).not.toContain("special-folder");
      expect(html(dir("src", { is_symlink: true }), "small", theme)).not.toContain("special-folder");
    }
  });
});
