/**
 * Full resolution on demand for the Preview pane (#1054).
 *
 * The pane shows a display-sized rendition of a large image. When the viewer
 * needs detail (fullscreen, zoom — `domain/preview-rendition`), the original
 * is loaded and decoded off-screen while the rendition stays on screen, and
 * handed back for the pane to swap in; there is no blank frame.
 *
 * One upgrade per shown rendition: a failed original keeps the rendition (the
 * best image available) rather than retrying on every zoom step. A result is
 * dropped when the pane has since shown something else, and the rendition's
 * own owner (the preview lifetime's request) rejects one for a newer file.
 */
import { loadPreviewImage, type PreviewImageOwner, type PreviewImageReady } from "./preview-image";

/** The rendition on screen: its source file and the load that showed it. */
export interface ShownRendition {
  readonly path: string;
  readonly cacheBust: string;
  /** The owner of the load that showed it, so the upgrade shares its lifetime. */
  readonly owner: PreviewImageOwner;
}

export interface FullResolutionUpgrade {
  /** The pane now shows `rendition`, or (null) an original or nothing. */
  showing(rendition: ShownRendition | null): void;
  /**
   * Loads the shown rendition's original once. Resolves with it only while
   * the same rendition is still shown, its load still current and the viewer
   * still `wanted()` full resolution; otherwise null. An original no longer
   * wanted (fullscreen left mid-load) is dropped and can be loaded again.
   */
  upgrade(wanted: () => boolean): Promise<PreviewImageReady | null>;
}

export function createFullResolutionUpgrade(load: typeof loadPreviewImage = loadPreviewImage): FullResolutionUpgrade {
  let shown: ShownRendition | null = null;
  let started: ShownRendition | null = null;

  return {
    showing(rendition) {
      shown = rendition;
      started = null;
    },
    async upgrade(wanted) {
      const target = shown;
      if (!target || started === target || !wanted()) return null;
      started = target;
      const image = await load(target.path, target.cacheBust, target.owner);
      if (shown !== target || image.status !== "ready" || !target.owner.isCurrent()) return null;
      if (!wanted()) {
        started = null;
        return null;
      }
      shown = null;
      return image;
    },
  };
}
