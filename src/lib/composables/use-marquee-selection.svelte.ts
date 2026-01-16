/**
 * Marquee (rubber-band) selection composable for FileList.
 * Issue: tauri-explorer-1k9k
 *
 * Extracts marquee selection logic from FileList to reduce complexity.
 */

export interface MarqueeRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface MarqueeOptions {
  headerHeight?: number;
  itemHeight?: number;
  backgroundClasses?: string[];
}

const DEFAULT_OPTIONS: Required<MarqueeOptions> = {
  headerHeight: 32,
  itemHeight: 32,
  backgroundClasses: [
    "file-rows",
    "content",
    "details-view",
    "virtual-viewport",
    "virtual-spacer-top",
    "virtual-spacer-bottom",
  ],
};

export function useMarqueeSelection(options: MarqueeOptions = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options };

  let isDragging = $state(false);
  let dragJustEnded = $state(false);
  let dragStart = $state<{ x: number; y: number } | null>(null);
  let dragCurrent = $state<{ x: number; y: number } | null>(null);
  let ctrlKeyHeld = $state(false);

  const marqueeRect = $derived.by((): MarqueeRect | null => {
    if (!dragStart || !dragCurrent) return null;
    return {
      left: Math.min(dragStart.x, dragCurrent.x),
      top: Math.min(dragStart.y, dragCurrent.y),
      width: Math.abs(dragCurrent.x - dragStart.x),
      height: Math.abs(dragCurrent.y - dragStart.y),
    };
  });

  function isBackgroundClick(target: HTMLElement): boolean {
    return config.backgroundClasses.some((cls) => target.classList.contains(cls));
  }

  function start(event: MouseEvent, containerRect: DOMRect): void {
    if (!isBackgroundClick(event.target as HTMLElement)) return;
    if (event.button !== 0) return; // Only left click

    // Blur any focused element before starting marquee
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }

    isDragging = true;
    ctrlKeyHeld = event.ctrlKey || event.metaKey;
    dragStart = {
      x: event.clientX - containerRect.left,
      y: Math.max(config.headerHeight, event.clientY - containerRect.top),
    };
    dragCurrent = { ...dragStart };

    event.preventDefault();
  }

  function move(event: MouseEvent, containerRect: DOMRect): void {
    if (!isDragging) return;

    dragCurrent = {
      x: Math.max(0, Math.min(event.clientX - containerRect.left, containerRect.width)),
      y: Math.max(config.headerHeight, event.clientY - containerRect.top),
    };
  }

  function end(): void {
    if (!isDragging) return;

    isDragging = false;
    dragStart = null;
    dragCurrent = null;

    // Prevent subsequent click from clearing selection
    dragJustEnded = true;
    requestAnimationFrame(() => {
      dragJustEnded = false;
    });
  }

  /**
   * Calculate indices of items intersecting with the marquee rectangle.
   * @param scrollTop Current scroll position of the container
   * @param totalItems Total number of items in the list
   */
  function getSelectedIndices(scrollTop: number, totalItems: number): number[] {
    if (!marqueeRect) return [];

    const marqueeTop = marqueeRect.top + scrollTop - config.headerHeight;
    const marqueeBottom = marqueeTop + marqueeRect.height;

    const startIndex = Math.max(0, Math.floor(marqueeTop / config.itemHeight));
    const endIndex = Math.min(totalItems - 1, Math.floor(marqueeBottom / config.itemHeight));

    const indices: number[] = [];
    for (let i = startIndex; i <= endIndex; i++) {
      indices.push(i);
    }
    return indices;
  }

  return {
    get isDragging() {
      return isDragging;
    },
    get dragJustEnded() {
      return dragJustEnded;
    },
    get ctrlKeyHeld() {
      return ctrlKeyHeld;
    },
    get marqueeRect() {
      return marqueeRect;
    },
    isBackgroundClick,
    start,
    move,
    end,
    getSelectedIndices,
  };
}
