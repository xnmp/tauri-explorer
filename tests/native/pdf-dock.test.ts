import { describe, expect, it } from 'vitest';
import { nativePdfDockError } from '../../e2e-tauri/macos-pdf-preview';

const window = { x: 0, y: 25, width: 804, height: 604 };
// Actual Mac2 run 37054032684: inner minimum-width pane overflows its
// clipped listing viewport; the native splitter identifies the real boundary.
const right = { viewport: { x: 385, y: 334, width: 419, height: 155 }, splitter: { x: 385, y: 110, width: 6, height: 477 }, listing: { x: 360, y: 110, width: 360, height: 465 } };
const top = { viewport: { x: 360, y: 230, width: 444, height: 176 }, splitter: { x: 360, y: 400, width: 444, height: 6 }, listing: { x: 360, y: 406, width: 444, height: 300 } };
const bottom = { viewport: { x: 360, y: 350, width: 444, height: 235 }, splitter: { x: 360, y: 230, width: 444, height: 6 }, listing: { x: 360, y: 110, width: 444, height: 300 } };
const check = (dock: 'Right' | 'Top' | 'Bottom', value: typeof right) => nativePdfDockError(dock, value.viewport, value.splitter, value.listing, window);

describe('native PDF dock boundary', () => {
  it('accepts the actual right dock despite the inner listing minimum width', () => { expect(check('Right', right)).toBeNull(); });
  it('accepts a top handle overlapping the final six content pixels', () => { expect(check('Top', top)).toBeNull(); });
  it('accepts a bottom preview below the actual horizontal boundary', () => { expect(check('Bottom', bottom)).toBeNull(); });
  it.each(['Top', 'Bottom'] as const)('rejects the right dock mislabeled %s', dock => { expect(check(dock, right)).not.toBeNull(); });
  it.each(['Right', 'Bottom'] as const)('rejects the top dock mislabeled %s', dock => { expect(check(dock, top)).not.toBeNull(); });
  it.each(['Right', 'Top'] as const)('rejects the bottom dock mislabeled %s', dock => { expect(check(dock, bottom)).not.toBeNull(); });
  it('rejects a disconnected top rectangle with matching horizontal extent', () => { expect(check('Top', { ...top, viewport: { ...top.viewport, height: 100 } })).not.toBeNull(); });
  it('rejects a floating narrow bottom rectangle', () => { expect(check('Bottom', { ...bottom, viewport: { ...bottom.viewport, x: 450, width: 200 } })).not.toBeNull(); });
  it('rejects a right preview crossing the native splitter', () => { expect(check('Right', { ...right, viewport: { ...right.viewport, x: 360 } })).not.toBeNull(); });
  it('rejects bottom placement above the splitter', () => { expect(check('Bottom', { ...bottom, viewport: { ...bottom.viewport, y: 120 } })).not.toBeNull(); });
  it('rejects top placement after the listing starts', () => { expect(check('Top', { ...top, listing: { ...top.listing, y: 110 } })).not.toBeNull(); });
  it('rejects a PDF clipped outside its owned window', () => { expect(check('Right', { ...right, viewport: { ...right.viewport, width: 500 } })).not.toBeNull(); });
  // #1925: the handle is a 10px hit strip reaching 3px past the dock's edge.
  const stripRight = { ...right, splitter: { x: 382, y: 110, width: 10, height: 477 } };
  const stripTop = { ...top, splitter: { x: 360, y: 399, width: 444, height: 10 } };
  const stripBottom = { ...bottom, splitter: { x: 360, y: 347, width: 444, height: 10 } };
  it('accepts the #1925 right hit strip reaching past the dock edge', () => { expect(check('Right', stripRight)).toBeNull(); });
  it('accepts the #1925 top hit strip reaching past the dock edge', () => { expect(check('Top', stripTop)).toBeNull(); });
  it('accepts the #1925 bottom hit strip reaching past the dock edge', () => { expect(check('Bottom', stripBottom)).toBeNull(); });
  it('rejects a right preview starting beyond the #1925 strip', () => { expect(check('Right', { ...stripRight, viewport: { ...stripRight.viewport, x: 400, width: 404 } })).not.toBeNull(); });
  it('rejects a top preview ending short of the #1925 strip', () => { expect(check('Top', { ...stripTop, viewport: { ...stripTop.viewport, height: 160 } })).not.toBeNull(); });
  it('rejects a bottom preview starting above the #1925 strip', () => { expect(check('Bottom', { ...stripBottom, viewport: { ...stripBottom.viewport, y: 330, height: 255 } })).not.toBeNull(); });
  it('rejects nonfinite coordinates', () => { expect(check('Top', { ...top, viewport: { ...top.viewport, x: NaN } })).not.toBeNull(); });
});
