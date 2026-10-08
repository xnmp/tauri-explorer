import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMarqueeSelection } from "$lib/composables/use-marquee-selection.svelte";

const rect = (
  left: number,
  top: number,
  width: number,
  height: number,
): DOMRect => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
  x: left,
  y: top,
  toJSON: () => ({}),
});
const containerRect = rect(100, 50, 600, 600);
const event = (clientX: number, clientY: number): MouseEvent =>
  ({
    clientX,
    clientY,
    buttons: 1,
    button: 0,
    ctrlKey: false,
    metaKey: false,
    target: { classList: { contains: (name: string) => name === "content" } },
    preventDefault: () => {},
  }) as unknown as MouseEvent;

describe("marquee visible row contracts after scrolling and virtualization", () => {
  let frame: FrameRequestCallback;
  beforeEach(() => {
    vi.stubGlobal("document", {
      activeElement: null,
      documentElement: { style: { zoom: "150%" } },
    });
    vi.stubGlobal("HTMLElement", class {});
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => vi.unstubAllGlobals());

  const drag = () => {
    const marquee = useMarqueeSelection({ headerHeight: 0 });
    marquee.start(event(110, 80), containerRect, 0);
    marquee.move(event(150, 115), containerRect, 0);
    frame(performance.now());
    return marquee;
  };
  const row = (index: number, position: () => DOMRect): HTMLElement =>
    ({
      dataset: { index: String(index) },
      getBoundingClientRect: position,
    }) as unknown as HTMLElement;

  it("uses actual zoomed positions after a CSS-space scroll rather than unscaled deltas", () => {
    const marquee = drag();
    const scroller = { scrollLeft: 0, scrollTop: 0 } as HTMLElement;
    const rows = [
      row(0, () => rect(120, 90 - scroller.scrollTop * 1.5, 40, 20)),
      row(1, () => rect(120, 120 - scroller.scrollTop * 1.5, 40, 20)),
    ];
    const container = {
      getBoundingClientRect: () => containerRect,
      querySelectorAll: () => rows,
    } as unknown as HTMLElement;
    expect(
      marquee.getSelectedIndicesFromDOM(container, ".entry-item", scroller),
    ).toEqual([0]);
    scroller.scrollTop = 20;
    expect(
      marquee.getSelectedIndicesFromDOM(container, ".entry-item", scroller),
    ).toEqual([1]);
  });

  it("selects the current global entry indices when scrolling remounts virtual rows", () => {
    const marquee = drag();
    const scroller = { scrollLeft: 0, scrollTop: 0 } as HTMLElement;
    let rows = [row(0, () => rect(120, 90, 40, 20))];
    const container = {
      getBoundingClientRect: () => containerRect,
      querySelectorAll: () => rows,
    } as unknown as HTMLElement;
    expect(
      marquee.getSelectedIndicesFromDOM(container, ".entry-item", scroller),
    ).toEqual([0]);
    scroller.scrollTop = 500;
    rows = [row(48, () => rect(120, 90, 40, 20))];
    expect(
      marquee.getSelectedIndicesFromDOM(container, ".entry-item", scroller),
    ).toEqual([48]);
  });

  it("refreshes remounted rows even when the scroll offset is unchanged", () => {
    const marquee = drag();
    let rows = [row(0, () => rect(120, 90, 40, 20))];
    const container = {
      scrollLeft: 0,
      scrollTop: 0,
      getBoundingClientRect: () => containerRect,
      querySelectorAll: () => rows,
    } as unknown as HTMLElement;
    expect(marquee.getSelectedIndicesFromDOM(container, ".entry-item")).toEqual(
      [0],
    );
    rows = [row(48, () => rect(120, 90, 40, 20))];
    expect(marquee.getSelectedIndicesFromDOM(container, ".entry-item")).toEqual(
      [48],
    );
  });

  it("refreshes a recycled row's global index without requiring a new element", () => {
    const marquee = drag();
    const rows = [row(0, () => rect(120, 90, 40, 20))];
    const container = {
      scrollLeft: 0,
      scrollTop: 0,
      getBoundingClientRect: () => containerRect,
      querySelectorAll: () => rows,
    } as unknown as HTMLElement;
    expect(marquee.getSelectedIndicesFromDOM(container, ".entry-item")).toEqual(
      [0],
    );
    rows[0].dataset.index = "48";
    expect(marquee.getSelectedIndicesFromDOM(container, ".entry-item")).toEqual(
      [48],
    );
  });

  it("excludes a Details row touched only by the bottom edge", () => {
    const marquee = useMarqueeSelection({ headerHeight: 32, itemHeight: 32 });
    marquee.start(event(110, 110), containerRect);
    marquee.move(event(150, 146), containerRect);
    frame(performance.now());
    expect(marquee.getSelectedIndices(0, 10)).toEqual([0]);
  });

  it("does not select entries for a zero-width or zero-height band", () => {
    for (const endpoint of [
      [110, 146],
      [150, 110],
    ]) {
      const marquee = useMarqueeSelection({ headerHeight: 32, itemHeight: 32 });
      marquee.start(event(110, 110), containerRect);
      marquee.move(event(endpoint[0], endpoint[1]), containerRect);
      frame(performance.now());
      expect(marquee.getSelectedIndices(0, 10)).toEqual([]);
      const rows = [row(0, () => rect(100, 90, 100, 50))];
      const container = {
        scrollLeft: 0,
        scrollTop: 0,
        getBoundingClientRect: () => containerRect,
        querySelectorAll: () => rows,
      } as unknown as HTMLElement;
      expect(
        marquee.getSelectedIndicesFromDOM(container, ".entry-item"),
      ).toEqual([]);
    }
  });
  it("keeps Details intersection unchanged when both drag directions reverse", () => {
    const marquee = useMarqueeSelection({ headerHeight: 32, itemHeight: 32 });
    marquee.start(event(150, 146), containerRect);
    marquee.move(event(110, 110), containerRect);
    frame(performance.now());
    expect(marquee.getSelectedIndices(0, 10)).toEqual([0]);
  });
});
