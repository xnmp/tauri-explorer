/**
 * Special folder icons everywhere (#1499): surfaces that know a folder only by
 * name (window tabs, sidebar bookmarks/recent rows, history menu, collapsed
 * preview root) resolve a synthetic directory entry and draw it through
 * FileIcon, so the active pack's native special variant appears there too.
 * Ordinary names and repository folders keep the host's own art.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createRawSnippet } from "svelte";
import { render } from "svelte/server";
import { resolveSpecialFolderVariant, specialFolderIconEntry } from "$lib/domain/special-folders";
import { specialFolderArt, specialFolderIconEntry as lazyIconEntry } from "$lib/components/icons/special-folder-icons.svelte";
import NamedFolderIcon from "$lib/components/NamedFolderIcon.svelte";
import { createWindowTabsManager } from "$lib/state/window-tabs.svelte";
import { settingsStore } from "$lib/state/settings.svelte";
import type { IconPack } from "$lib/domain/icon-themes";

const PACKS: IconPack[] = ["material", "classic", "minimal", "catppuccin"];

describe("specialFolderIconEntry", () => {
  it("gives a special folder name a directory entry every pack draws as that kind", () => {
    const entry = specialFolderIconEntry("src", { path: "/work/app/src" });
    expect(entry).toEqual({ name: "src", path: "/work/app/src", kind: "directory", size: 0, modified: "" });
    for (const pack of PACKS) {
      expect(resolveSpecialFolderVariant(entry!, pack, "small")?.kind).toBe("src");
    }
    expect(specialFolderIconEntry("Node_Modules")?.name).toBe("Node_Modules");
    expect(resolveSpecialFolderVariant(specialFolderIconEntry(".github")!, "material", "small")?.kind).toBe("github");
  });

  it("returns null for an ordinary folder name, so the host keeps its own folder art", () => {
    for (const name of ["Folder", "my-project", "/", "", "srcs-old"]) expect(specialFolderIconEntry(name)).toBeNull();
  });

  it("returns null for a repository the host already marks with its Git styling", () => {
    expect(specialFolderIconEntry("src", { repository: true })).toBeNull();
    expect(specialFolderIconEntry("src", { repository: false })).not.toBeNull();
  });
});

describe("startup seam", () => {
  it("resolves through the lazy special-folder chunk, then renders FileIcon's special variant", async () => {
    specialFolderArt();
    await import("$lib/components/icons/SpecialFolderArt.svelte");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lazyIconEntry("tests")?.name).toBe("tests");
    expect(lazyIconEntry("Folder")).toBeNull();
    expect(lazyIconEntry("src", true)).toBeNull();

    const fallback = createRawSnippet(() => ({ render: () => '<svg class="host-folder"></svg>' }));
    const special = render(NamedFolderIcon as never, { props: { name: "src", class: "tab-icon-special", children: fallback } } as never).body;
    expect(special).toContain('class="tab-icon-special"');
    expect(special).toContain('data-special-folder="src"');
    expect(special).not.toContain("host-folder");

    const plain = render(NamedFolderIcon as never, { props: { name: "Folder", class: "tab-icon-special", children: fallback } } as never).body;
    expect(plain).toContain("host-folder");
    expect(plain).not.toContain("data-special-folder");
  });
});

describe("tab display folder name", () => {
  afterEach(() => settingsStore.update({ tabTitleGitRoot: true }));

  it("exposes a single-pane tab's own folder name, even when its title is disambiguated", () => {
    settingsStore.update({ tabTitleGitRoot: false });
    const manager = createWindowTabsManager();
    manager.init("/home/user", true);
    const a = manager.createTab("/one/src");
    const b = manager.createTab("/two/src");
    for (const tab of [a, b]) {
      const display = manager.getTabDisplay(tab);
      expect(display.folder).toBe("src");
      expect(specialFolderIconEntry(display.folder!)).not.toBeNull();
    }
    expect(manager.getTabDisplay(a).name).not.toBe("src");
    expect(manager.getTabDisplay(manager.createTab("/home/user/Folder")).folder).toBe("Folder");
  });

  it("names no folder for a multi-pane tab (its title joins every pane)", () => {
    settingsStore.update({ tabTitleGitRoot: false });
    const manager = createWindowTabsManager();
    manager.init("/home/user/src", true);
    manager.splitPane("right", "/home/user/src");
    const tab = manager.activeTab!;
    expect(manager.getTabDisplay(tab).folder).toBeUndefined();
  });

  it("keeps the git decoration (no special folder) for a tab inside a repository", async () => {
    const manager = createWindowTabsManager();
    manager.init("/home/user", true);
    const tab = manager.createTab("/home/user/Documents/project/src");
    await manager.ensureGitRoot(manager.getTabPath(tab.id)!);
    const display = manager.getTabDisplay(tab);
    expect(display.isGitRoot).toBe(true);
    expect(display.folder).toBeUndefined();
  });
});
