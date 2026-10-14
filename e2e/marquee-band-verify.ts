/**
 * Shared verifier for the transform-only marquee band (#1051): drives a real
 * drag and asserts layout boxes, rendered boxes and rasterised pixels. Used by
 * `marquee-compositor-only.spec.ts` and the classic-scrollbar variant, which
 * needs its own browser launch options and therefore its own spec file.
 */
import { expect, type Page } from "./fixtures";
import { decodePng, colorDistance } from "./png-pixels";

/** Drag from the background bottom-right of the listing up across the last row and verify the band. */
export async function dragAndVerifyBand(page: Page, options: { bottomInset: number }) {
  const geometry = await page.evaluate((bottomInset) => {
    const content = document.querySelector(".file-list .content")!;
    const box = content.getBoundingClientRect();
    const entries = Array.from(content.querySelectorAll<HTMLElement>(".entry-item"))
      .map((element) => element.getBoundingClientRect());
    const bottom = Math.max(...entries.map((rect) => rect.bottom));
    // Start on background at the pane's bottom-right, drag up-left across
    // the last row: a band as tall as the pane makes any base/size mismatch
    // (a few device pixels) measurable. Stay clear of a horizontal scrollbar
    // on `.content`, which swallows pointer presses and paints its own track.
    const start = { x: Math.round(box.right - 30), y: Math.round(box.bottom - bottomInset) };
    const end = { x: Math.round(box.left + 40), y: Math.round(bottom - 20) };
    return {
      start, end, rowsBottom: bottom,
      background: !document.elementFromPoint(start.x, start.y)?.closest(".entry-item"),
    };
  }, options.bottomInset);
  expect(geometry.background).toBe(true);
  expect(geometry.start.y).toBeGreaterThan(geometry.rowsBottom + 16);

  await page.mouse.move(geometry.start.x, geometry.start.y);
  await page.mouse.down();
  await page.mouse.move(geometry.end.x, geometry.end.y, { steps: 8 });
  const band = page.locator(".marquee-rect");
  const expected = {
    left: Math.min(geometry.start.x, geometry.end.x),
    top: Math.min(geometry.start.y, geometry.end.y),
    right: Math.max(geometry.start.x, geometry.end.x),
    bottom: Math.max(geometry.start.y, geometry.end.y),
  };
  const tolerance = 3;
  // The last rAF-throttled move may still be pending; wait for the rendered
  // band to reach the drag's end before reading the layers.
  await expect
    .poll(async () => {
      const box = await band.boundingBox();
      return box ? Math.abs(box.x + box.width - expected.right) + Math.abs(box.y + box.height - expected.bottom) : Infinity;
    })
    .toBeLessThan(tolerance);

  const layers = await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>(".file-list .content")!;
    const read = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        // Layout box: the element's own size, before transforms.
        layoutWidth: (element as HTMLElement).offsetWidth,
        layoutHeight: (element as HTMLElement).offsetHeight,
        transform: style.transform,
        willChange: style.willChange,
        rendered: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      };
    };
    return {
      // The box `width/height: 100%` resolve against: excludes `.content`'s own scrollbars.
      container: { width: content.clientWidth, height: content.clientHeight },
      fill: read(document.querySelector(".marquee-rect")!),
      edges: Array.from(document.querySelectorAll(".marquee-edge")).map(read),
    };
  });
  // Rasterised proof, independent of DOM geometry: sample the screenshot
  // just inside and just outside the band's far edges on empty background.
  // CSS scale keeps sample coordinates valid on a deviceScaleFactor 2 project.
  const shot = decodePng(await page.screenshot({ scale: "css" }));
  await page.mouse.up();

  // (a) Nothing about the layers' layout changed with the pointer: the fill
  // is still the container-sized box it was given at drag start, every edge
  // is a one-pixel line of the container's length, and the band geometry
  // lives entirely in a matrix transform on layers promoted for compositing.
  // offsetWidth and clientWidth snap a fractional (zoomed) box independently.
  const near = (a: number, b: number) => Math.abs(a - b) <= 1;
  expect(near(layers.fill.layoutWidth, layers.container.width), "fill layout width equals the client box").toBe(true);
  expect(near(layers.fill.layoutHeight, layers.container.height), "fill layout height equals the client box").toBe(true);
  expect(layers.edges).toHaveLength(4);
  const horizontal = layers.edges.filter((edge) => edge.layoutHeight === 1 && near(edge.layoutWidth, layers.container.width));
  const vertical = layers.edges.filter((edge) => edge.layoutWidth === 1 && near(edge.layoutHeight, layers.container.height));
  expect(horizontal, "two container-wide 1px edges").toHaveLength(2);
  expect(vertical, "two container-tall 1px edges").toHaveLength(2);
  for (const layer of [layers.fill, ...layers.edges]) {
    expect(layer.transform).toMatch(/^matrix\(/);
    expect(layer.willChange).toBe("transform");
  }

  // (b) The rendered band still frames the drag in viewport space.
  for (const side of ["left", "top", "right", "bottom"] as const) {
    expect(Math.abs(layers.fill.rendered[side] - expected[side]), `fill ${side}`).toBeLessThan(tolerance);
  }
  // Each edge is a one-pixel line lying on the corresponding side of the fill.
  const union = layers.edges.reduce(
    (acc, edge) => ({
      left: Math.min(acc.left, edge.rendered.left),
      top: Math.min(acc.top, edge.rendered.top),
      right: Math.max(acc.right, edge.rendered.right),
      bottom: Math.max(acc.bottom, edge.rendered.bottom),
    }),
    { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
  );
  for (const side of ["left", "top", "right", "bottom"] as const) {
    expect(Math.abs(union[side] - layers.fill.rendered[side]), `edge union ${side}`).toBeLessThan(1.5);
  }
  const thin = layers.edges.map((edge) =>
    Math.min(edge.rendered.right - edge.rendered.left, edge.rendered.bottom - edge.rendered.top),
  );
  for (const thickness of thin) expect(thickness).toBeLessThanOrEqual(1.5);

  // (c) What was actually painted matches: the tinted fill reaches the
  // band's right and bottom edges and stops there. The band's far corner
  // lies on empty background below the rows, so a tint there can only be
  // the band. (Under fractional zoom a wrongly rasterised layer paints a
  // visibly smaller band while every DOM measurement above still passes.)
  const px = (x: number, y: number) => shot.pixel(Math.round(x), Math.round(y));
  const yBelowRows = Math.round((geometry.rowsBottom + expected.bottom) / 2);
  const xInBand = Math.round((expected.left + expected.right) / 2);
  const outside = px(expected.right + 8, yBelowRows);
  const farOutside = px(xInBand, expected.bottom + 8);
  expect(colorDistance(outside, farOutside), "both reference samples are plain background").toBeLessThan(12);
  const insideRight = px(expected.right - 4, yBelowRows);
  const insideBottom = px(xInBand, expected.bottom - 4);
  expect(colorDistance(insideRight, outside), "fill tint reaches the right edge").toBeGreaterThan(12);
  expect(colorDistance(insideBottom, outside), "fill tint reaches the bottom edge").toBeGreaterThan(12);
  const shortRight = px(expected.right - 4 - (expected.right - expected.left) * 0.2, yBelowRows);
  expect(colorDistance(shortRight, insideRight), "fill is uniform up to the edge").toBeLessThan(12);
}

