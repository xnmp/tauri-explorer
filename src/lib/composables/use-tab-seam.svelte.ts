/**
 * Wires the tab seam marks (`tab-seam-marks.ts`, #1734) to the
 * title bar. The marks module is loaded lazily, to keep it out of the startup
 * bundle, and cached: once loaded, every tab change re-measures synchronously
 * inside the same flush. Awaiting `import()` per change let Chromium paint
 * frames with the marks cleared (the strip shade flashed when a tab opened).
 */
import { layoutStore } from "$lib/state/layout.svelte";
import type { TabSeam } from "./tab-seam-marks";

type Marks = typeof import("./tab-seam-marks");

let loaded: Marks | null = null;
let loading: Promise<Marks> | null = null;

function load(): Promise<Marks> {
  loading ??= import("./tab-seam-marks").then((marks) => (loaded = marks));
  return loading;
}

/**
 * Keep the marks on `titlebar()` while the layout's active tab owns the
 * window (`layoutStore.tabSeam`: Floating Islands and Default).
 * `changes()` reads whatever reactive state moves the active tab (tab list,
 * active tab, strip visibility); each change re-measures immediately.
 */
export function useTabSeam(titlebar: () => HTMLElement | undefined, changes: () => unknown): void {
  let seam: TabSeam | null = null;

  $effect(() => {
    const bar = titlebar();
    if (!bar || !layoutStore.tabSeam) return;
    let disposed = false;
    const attach = (marks: Marks) => {
      if (!disposed) seam = marks.attachTabSeam(bar);
    };
    if (loaded) attach(loaded);
    else load().then(attach, (error) => console.error("Tab seam marks failed to load:", error));
    return () => {
      disposed = true;
      seam?.destroy();
      seam = null;
    };
  });

  $effect(() => {
    changes();
    seam?.update();
  });
}
