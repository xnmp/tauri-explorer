import { prepareWithSegments, measureNaturalWidth } from "@chenglou/pretext";

export const CRUMB_FONT = "500 13px 'Inter Variable', Inter";
export const SEPARATOR_WIDTH = 16; // 12px SVG icon + 4px horizontal padding (2px each side)
export const CRUMB_H_PAD = 16; // 8px padding each side
export const CONTAINER_H_PAD = 20; // 10px padding each side

export function measureCrumbWidth(name: string): number {
  return measureNaturalWidth(prepareWithSegments(name, CRUMB_FONT)) + CRUMB_H_PAD + SEPARATOR_WIDTH;
}

export const ELLIPSIS_WIDTH = measureCrumbWidth("…");

export interface Breadcrumb {
  name: string;
  path: string | null;
}

export function truncateBreadcrumbs(
  crumbs: Breadcrumb[],
  containerWidth: number,
): Breadcrumb[] {
  if (crumbs.length <= 2 || containerWidth <= 0) return crumbs;

  const available = containerWidth - CONTAINER_H_PAD;
  const widths = crumbs.map((c) => measureCrumbWidth(c.name));
  const totalWidth = widths.reduce((sum, w) => sum + w, 0);

  if (totalWidth <= available) return crumbs;

  const firstWidth = widths[0];
  for (let collapse = 1; collapse <= crumbs.length - 2; collapse++) {
    const tailStart = 1 + collapse;
    const tailWidth = widths.slice(tailStart).reduce((sum, w) => sum + w, 0);
    const needed = firstWidth + ELLIPSIS_WIDTH + tailWidth;
    if (needed <= available) {
      const head = crumbs.slice(0, 1);
      const tail = crumbs.slice(tailStart);
      return [...head, { name: "…", path: null }, ...tail];
    }
  }

  return [crumbs[0], { name: "…", path: null }, crumbs[crumbs.length - 1]];
}

export function measureTotalBreadcrumbWidth(names: string[]): number {
  return names.reduce((sum, name) => sum + measureCrumbWidth(name), 0) + CONTAINER_H_PAD;
}
