/** How far the right end of scrolled content lies beyond the scrollport's visible edge (px, never negative). */
export function hiddenRight(scrollWidth: number, scrollLeft: number, clientWidth: number): number {
  const hidden = scrollWidth - scrollLeft - clientWidth;
  return Number.isFinite(hidden) ? Math.max(0, Math.round(hidden)) : 0;
}
