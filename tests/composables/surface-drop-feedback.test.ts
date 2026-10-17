import { describe, expect, it } from "vitest";
import { createSurfaceDropFeedback, surfaceDropPath, type SurfaceDropTargets } from "$lib/composables/surface-drop-feedback";
import type { FileEntry } from "$lib/domain/file";

const folder = (path: string) => ({ name: path.split("/").at(-1), path, kind: "directory", size: 0, modified: "" }) as FileEntry;

/** A fake element: `matches` lists the selectors its closest() finds, with that ancestor's path. */
const element = (matches: Record<string, string | undefined>) => ({
  closest: (selector: string) => selector in matches ? { closest: () => null, dataset: { path: matches[selector] } } : null,
});

describe("surfaceDropPath", () => {
  it("targets a nested folder's pseudo-row, else the card's own folder", () => {
    expect(surfaceDropPath(element({ ".peek-drop-target[data-path]": "/d/open/sub" }), "/d/open")).toBe("/d/open/sub");
    expect(surfaceDropPath(element({}), "/d/open")).toBe("/d/open");
    expect(surfaceDropPath(element({ ".peek-drop-target[data-path]": "" }), "/d/open")).toBe("/d/open");
  });
  it("leaves rows (their own targets) and non-element targets alone", () => {
    expect(surfaceDropPath(element({ ".entry-item": "/d/open/a.txt", ".peek-drop-target[data-path]": "/d/open" }), "/d/open")).toBeNull();
    for (const target of [null, undefined, {}, "text", 3]) expect(surfaceDropPath(target, "/d/open")).toBeNull();
  });
});

describe("createSurfaceDropFeedback", () => {
  function harness() {
    const calls: string[] = [];
    const targets: SurfaceDropTargets = {
      handleDragOver: (_, entry) => calls.push(`over ${entry.path}`),
      handleDragLeave: (_, entry) => calls.push(`leave ${entry.path}`),
      handleDrop: (_, entry) => calls.push(`drop ${entry.path}`),
      releaseDropTarget: path => calls.push(`release ${path}`),
    };
    let next: FileEntry | null = null;
    const surface = createSurfaceDropFeedback(() => targets, () => next);
    const event = {} as DragEvent;
    return { calls, surface, event, at: (entry: FileEntry | null) => { next = entry; } };
  }

  it("retires the surface's feedback when the pointer reaches a row inside it, which fires no leave", () => {
    const { calls, surface, event, at } = harness();
    at(folder("/d/open"));
    surface.over(event);
    surface.over(event);
    at(null);
    surface.over(event);
    expect(calls).toEqual(["over /d/open", "over /d/open", "release /d/open"]);
    expect(surface.current).toBeNull();
  });

  it("moves feedback between folders and forwards leaves to the current one", () => {
    const { calls, surface, event, at } = harness();
    surface.leave(event);
    at(folder("/d/open"));
    surface.over(event);
    at(folder("/d/open/sub"));
    surface.over(event);
    surface.leave(event);
    expect(calls).toEqual(["over /d/open", "release /d/open", "over /d/open/sub", "leave /d/open/sub"]);
    expect(surface.current?.path).toBe("/d/open/sub");
  });

  it("drops on the folder under the pointer and clears its feedback first", () => {
    const { calls, surface, event, at } = harness();
    at(folder("/d/open"));
    surface.over(event);
    surface.drop(event);
    expect(calls).toEqual(["over /d/open", "release /d/open", "drop /d/open"]);
    at(null);
    surface.drop(event);
    expect(calls).toHaveLength(3);
    expect(surface.current).toBeNull();
  });
});
