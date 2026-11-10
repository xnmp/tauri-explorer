export interface Size {
  readonly width: number;
  readonly height: number;
}
export interface Point {
  readonly x: number;
  readonly y: number;
}
export interface PdfView {
  readonly zoom: number;
  readonly pan: Point;
}

/** Measure the surface's effective scale, including fullscreen's inverse root zoom. */
export function pdfPointerPoint(
  client: Point,
  rect: { left: number; top: number; width: number; height: number },
  layout: Size,
): Point {
  return {
    x:
      rect.width > 0 ? ((client.x - rect.left) * layout.width) / rect.width : 0,
    y:
      rect.height > 0
        ? ((client.y - rect.top) * layout.height) / rect.height
        : 0,
  };
}
export const PDF_FIT: PdfView = { zoom: 1, pan: { x: 0, y: 0 } };
export const PDF_MARGIN = 16;

export function fitPdfScale(page: Size, viewport: Size): number {
  if (
    ![page.width, page.height, viewport.width, viewport.height].every(
      (n) => Number.isFinite(n) && n > 0,
    )
  )
    return 0;
  return Math.min(
    Math.max(1, viewport.width - PDF_MARGIN * 2) / page.width,
    Math.max(1, viewport.height - PDF_MARGIN * 2) / page.height,
  );
}

export function constrainPdfPan(
  pan: Point,
  content: Size,
  viewport: Size,
): Point {
  const clamp = (value: number, length: number, available: number) => {
    const limit = Math.max(0, (length - available) / 2 + PDF_MARGIN);
    return Math.max(
      -limit,
      Math.min(limit, Number.isFinite(value) ? value : 0),
    );
  };
  return {
    x: clamp(pan.x, content.width, viewport.width),
    y: clamp(pan.y, content.height, viewport.height),
  };
}

/** All values are layout CSS pixels; pointer conversion happens once at the UI boundary. */
export function zoomPdf(
  view: PdfView,
  nextZoom: number,
  anchor: Point,
  page: Size,
  viewport: Size,
): PdfView {
  const zoom = Math.max(
    1,
    Math.min(8, Number.isFinite(nextZoom) ? nextZoom : 1),
  );
  if (zoom === 1) return PDF_FIT;
  const ratio = zoom / view.zoom;
  const scale = fitPdfScale(page, viewport) * zoom;
  return {
    zoom,
    pan: constrainPdfPan(
      {
        x: anchor.x - (anchor.x - view.pan.x) * ratio,
        y: anchor.y - (anchor.y - view.pan.y) * ratio,
      },
      { width: page.width * scale, height: page.height * scale },
      viewport,
    ),
  };
}

export function panPdf(
  view: PdfView,
  delta: Point,
  page: Size,
  viewport: Size,
): PdfView {
  const scale = fitPdfScale(page, viewport) * view.zoom;
  return {
    ...view,
    pan: constrainPdfPan(
      { x: view.pan.x + delta.x, y: view.pan.y + delta.y },
      { width: page.width * scale, height: page.height * scale },
      viewport,
    ),
  };
}

export function resizePdfView(
  view: PdfView,
  page: Size,
  previous: Size,
  next: Size,
): PdfView {
  const oldScale = fitPdfScale(page, previous);
  const newScale = fitPdfScale(page, next);
  if (!oldScale || !newScale || view.zoom === 1) return PDF_FIT;
  return {
    ...view,
    pan: constrainPdfPan(
      {
        x: (view.pan.x * newScale) / oldScale,
        y: (view.pan.y * newScale) / oldScale,
      },
      {
        width: page.width * newScale * view.zoom,
        height: page.height * newScale * view.zoom,
      },
      next,
    ),
  };
}

/** PDF actions and file/script URLs are never executed by the preview. */
export function safePdfLink(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return ["https:", "http:", "mailto:"].includes(url.protocol)
      ? url.href
      : null;
  } catch {
    return null;
  }
}
