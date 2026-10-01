import { describe, expect, it } from "vitest";
import {
  PDF_FIT,
  fitPdfScale,
  zoomPdf,
  panPdf,
  resizePdfView,
  safePdfLink,
  pdfPointerPoint,
} from "$lib/domain/pdf-preview";

describe("PDF viewing geometry", () => {
  const page = { width: 600, height: 800 };
  const viewport = { width: 400, height: 500 };
  it.each([1, 1.25, 1.5, 2])(
    "converts pointers once using the actual surface scale %s",
    (scale) => {
      const rect = {
        left: 20,
        top: 30,
        width: viewport.width * scale,
        height: viewport.height * scale,
      };
      expect(
        pdfPointerPoint(
          { x: 20 + 60 * scale, y: 30 + 50 * scale },
          rect,
          viewport,
        ),
      ).toEqual({ x: 60, y: 50 });
    },
  );
  it("fits portrait and landscape pages inside equal margins", () => {
    expect(fitPdfScale(page, viewport) * page.height).toBe(468);
    expect(fitPdfScale({ width: 800, height: 600 }, viewport) * 800).toBe(368);
  });
  it("keeps the page centered at 130% button zoom", () => {
    expect(zoomPdf(PDF_FIT, 1.3, { x: 0, y: 0 }, page, viewport)).toEqual({
      zoom: 1.3,
      pan: { x: 0, y: 0 },
    });
  });
  it("keeps a document landmark under the wheel pointer", () => {
    const anchor = { x: 40, y: -60 };
    const next = zoomPdf(
      { zoom: 2, pan: { x: 10, y: 20 } },
      3,
      anchor,
      page,
      viewport,
    );
    expect((anchor.x - next.pan.x) / next.zoom).toBe((anchor.x - 10) / 2);
    expect((anchor.y - next.pan.y) / next.zoom).toBe((anchor.y - 20) / 2);
  });
  it("can reach every edge while bounding empty space", () => {
    const view = panPdf(
      { zoom: 4, pan: { x: 0, y: 0 } },
      { x: 100000, y: -100000 },
      page,
      viewport,
    );
    const scale = fitPdfScale(page, viewport) * 4;
    expect(view.pan.x - (page.width * scale) / 2).toBe(
      -viewport.width / 2 + 16,
    );
    expect(view.pan.y + (page.height * scale) / 2).toBe(
      viewport.height / 2 - 16,
    );
  });
  it("reset clears both pan axes after zoom and clamps zoom bounds", () => {
    expect(
      zoomPdf(
        { zoom: 4, pan: { x: 100, y: -100 } },
        1,
        { x: 80, y: 80 },
        page,
        viewport,
      ),
    ).toEqual(PDF_FIT);
    expect(zoomPdf(PDF_FIT, 100, { x: 0, y: 0 }, page, viewport).zoom).toBe(8);
  });
  it("resize preserves the document point at the viewport center", () => {
    const previous = { zoom: 3, pan: { x: 30, y: 40 } };
    const nextSize = { width: 600, height: 700 };
    const next = resizePdfView(previous, page, viewport, nextSize);
    expect(next.pan.x / fitPdfScale(page, nextSize)).toBeCloseTo(
      previous.pan.x / fitPdfScale(page, viewport),
    );
    expect(next.pan.y / fitPdfScale(page, nextSize)).toBeCloseTo(
      previous.pan.y / fitPdfScale(page, viewport),
    );
  });
  it.each([0, NaN, Infinity, -100])(
    "rejects invalid page dimensions %s",
    (width) => {
      expect(fitPdfScale({ width, height: 800 }, viewport)).toBe(0);
    },
  );
  it.each([
    "javascript:alert(1)",
    "file:///secret",
    "data:text/html,bad",
    null,
    {},
  ])("rejects unsafe PDF links %s", (url) => {
    expect(safePdfLink(url)).toBeNull();
  });
  it("retains ordinary external links", () =>
    expect(safePdfLink("https://example.com/page")).toBe(
      "https://example.com/page",
    ));
});
