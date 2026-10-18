/**
 * Per-view support shared by both Tiles renderers (classic `TilesView` and the
 * Folder Peek `TilePanelsView`, #1241): videos whose thumbnail failed, and the
 * scroll-jank diagnostics (#593).
 */
import { createScrollJankMonitor } from "$lib/domain/scroll-jank-monitor";
import { logFrontendDiagnostic } from "$lib/api/frontend-log";

/** Videos whose thumbnail generation failed (e.g. no ffmpeg) fall back to the
 * plain icon. Keyed by path; reset on navigation. */
export function useUnavailableThumbs(getDirectory: () => string) {
  let unavailable = $state(new Set<string>());
  $effect(() => {
    // Reset when the directory changes.
    getDirectory();
    unavailable = new Set<string>();
  });
  return {
    has: (path: string): boolean => unavailable.has(path),
    mark(path: string): void {
      if (unavailable.has(path)) return;
      const next = new Set(unavailable);
      next.add(path);
      unavailable = next;
    },
  };
}

/** Sample rAF gaps while the tiles scroller is scrolling and report janky
 * windows into the native app log, alongside the backend's `thumb:` lines. */
export function useTilesScrollJank(getRoot: () => HTMLElement | undefined, getInfo: () => { entries: number; thumbnailSize: string }) {
  $effect(() => {
    const root = getRoot();
    if (!root) return;
    const monitor = createScrollJankMonitor();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;

    function onScroll() {
      monitor.start();
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        const report = monitor.stop();
        if (report && report.longFrames > 0) {
          logFrontendDiagnostic("tiles-scroll-jank", {
            ...getInfo(),
            frames: report.frames,
            longFrames: report.longFrames,
            worstFrameMs: Math.round(report.worstFrameMs),
            durationMs: Math.round(report.durationMs),
          });
        }
      }, 400);
    }

    // Scroll doesn't bubble, but capture-phase listeners on an ancestor still
    // see descendant scrolls — the VirtualList scroller lives inside the root.
    root.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      root.removeEventListener("scroll", onScroll, { capture: true });
      clearTimeout(idleTimer);
      monitor.stop();
    };
  });
}
