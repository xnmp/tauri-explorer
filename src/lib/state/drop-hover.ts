/** One live drag owns hover feedback; layout changes can re-hit-test its last point. */
export function createDropHover() {
  let current: (() => void) | null = null;
  return {
    set(refresh: () => void): void { current = refresh; },
    clear(refresh: () => void): void { if (current === refresh) current = null; },
    refresh(): void { current?.(); },
  };
}
export const dropHover = createDropHover();
