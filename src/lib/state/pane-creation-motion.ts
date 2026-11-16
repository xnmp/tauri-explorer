import { paneCreation, sameLayout, type PaneCreation } from '$lib/domain/pane-presentation';
import type { PaneNode, LeafRect } from '$lib/domain/pane-layout';
import { stablePaneFrame, visiblePaneRect, type PaneInsets } from '$lib/domain/pane-motion';

export const PANE_CREATION_MS = 220;
interface Frame { element: HTMLElement; rect: LeafRect; clip: string }
type Snapshot = Map<string, Frame>;

function clipInsets(clip: string): PaneInsets {
  const values = clip.match(/^inset\(([^)]+)\)$/)?.[1].split(/\s+/).map(parseFloat) ?? [0];
  const [top, right = top, bottom = top, left = right] = values;
  return [top, right, bottom, left];
}

/** Carry a still-opening ancestor's visible region into a nested entrance. */
function inheritedInset(source: Frame, target: LeafRect): number[] {
  const [top, right, bottom, left] = clipInsets(source.clip);
  return [
    top > 0 ? Math.max(0, source.rect.y + top - target.y) : 0,
    right > 0 ? Math.max(0, target.x + target.w - (source.rect.x + source.rect.w - right)) : 0,
    bottom > 0 ? Math.max(0, target.y + target.h - (source.rect.y + source.rect.h - bottom)) : 0,
    left > 0 ? Math.max(0, source.rect.x + left - target.x) : 0,
  ];
}
const inset = (values: readonly number[]) => `inset(${values.map(value => `${value}px`).join(' ')})`;

/** One cancellable, presentation-only animation lifetime per retained tab.
 * File-view dimensions stay fixed while the visible boundary moves through
 * clipping. The live layout settles once, on completion or cancellation. */
export function createPaneCreationMotion(root: () => HTMLElement | undefined, reduced: () => boolean) {
  let previous: PaneNode | undefined;
  let pending: { creation: PaneCreation; before: Snapshot; width: number; height: number } | undefined;
  const animations = new Set<Animation>();

  function finish() {
    pending = undefined;
    for (const animation of animations) animation.cancel();
    animations.clear();
  }
  function capture(): { frames: Snapshot; width: number; height: number } | undefined {
    const canvas = root();
    if (!canvas) return;
    const origin = canvas.getBoundingClientRect();
    const width = parseFloat(getComputedStyle(canvas).width), height = parseFloat(getComputedStyle(canvas).height);
    if (origin.width <= 0 || origin.height <= 0 || width <= 0 || height <= 0) return;
    const sx = width / origin.width, sy = height / origin.height;
    const frames: Snapshot = new Map();
    for (const element of canvas.querySelectorAll<HTMLElement>('[data-pane-motion]')) {
      const rect = element.getBoundingClientRect();
      frames.set(element.dataset.paneMotion!, { element, clip: getComputedStyle(element).clipPath,
        rect: { x: (rect.left - origin.left) * sx, y: (rect.top - origin.top) * sy, w: rect.width * sx, h: rect.height * sy } });
    }
    return { frames, width, height };
  }
  function prepare(next: PaneNode, shown: boolean) {
    // Focus updates can re-publish the same tree. They must not settle an
    // admitted press before its click-owned selection has run.
    if (shown && previous && sameLayout(previous, next)) return;
    const creation = shown && !reduced() ? paneCreation(previous, next) : undefined;
    // Capture the currently displayed (possibly interrupted) frame before
    // cancelling its effects. A replacement starts from what the user saw.
    const snapshot = creation ? capture() : undefined;
    finish();
    previous = shown ? next : undefined;
    if (creation && snapshot) pending = { creation, before: snapshot.frames, width: snapshot.width, height: snapshot.height };
  }
  function animate(element: HTMLElement, keyframes: Keyframe[]) {
    const animation = element.animate(keyframes, { duration: PANE_CREATION_MS, easing: 'cubic-bezier(0.33, 1, 0.68, 1)', fill: 'both' });
    animations.add(animation);
    const release = () => { animations.delete(animation); animation.cancel(); };
    void animation.finished.then(release, release);
  }
  function play() {
    const plan = pending;
    pending = undefined;
    if (!plan || reduced()) return;
    const target = capture();
    if (!target || Math.abs(target.width - plan.width) > .5 || Math.abs(target.height - plan.height) > .5) return;
    const { creation, before } = plan;
    const source = before.get(`pane:${creation.sourceId}`);
    const incoming = target.frames.get(`pane:${creation.paneId}`);
    const divider = target.frames.get(`split:${creation.splitId}`);
    if (!source || !incoming || !divider) return;
    const bounds = (r: LeafRect) => ({ left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    for (const [key, frame] of target.frames) {
      const old = before.get(key);
      if (!old || old.element !== frame.element) continue;
      const a = old.rect, b = frame.rect;
      if (key.startsWith('pane:')) {
        if (Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.w - b.w), Math.abs(a.h - b.h)) < .1 && old.clip === 'none') continue;
        const plan = stablePaneFrame(a, clipInsets(old.clip), b);
        // Keep left/top positioning: pane-hosted fixed overlays must retain
        // their window coordinate space, which a parent transform would change.
        animate(frame.element, [{ ...bounds(plan.from), clipPath: inset(plan.fromClip) }, { ...bounds(plan.to), clipPath: inset(plan.toClip) }]);
      } else {
        animate(frame.element, [{ transform: `translate(${a.x - b.x}px, ${a.y - b.y}px)`, width: `${a.w}px`, height: `${a.h}px`, clipPath: old.clip === 'none' ? 'inset(0px)' : old.clip }, { transform: 'translate(0px, 0px)', width: `${b.w}px`, height: `${b.h}px`, clipPath: 'inset(0px)' }]);
      }
    }
    const horizontal = creation.direction === 'row';
    const visible = visiblePaneRect(source.rect, clipInsets(source.clip));
    const start = horizontal ? visible.x : visible.y;
    const extent = horizontal ? visible.w : visible.h;
    const edge = creation.first ? start - (horizontal ? divider.rect.w : divider.rect.h) : start + extent;
    const end = horizontal ? divider.rect.x : divider.rect.y;
    const delta = edge - end;
    const amount = Math.max(0, creation.first ? -delta : delta);
    const clip = inheritedInset(source, incoming.rect);
    const side = horizontal ? (creation.first ? 1 : 3) : (creation.first ? 2 : 0);
    clip[side] = Math.max(clip[side], amount);
    // The inset and divider use the same distance/easing. The gap stays open
    // throughout; no faded duplicate or horizontally stretched text is used.
    animate(incoming.element, [{ clipPath: inset(clip) }, { clipPath: 'inset(0px 0px 0px 0px)' }]);
    const dividerClip = inheritedInset(source, divider.rect);
    // Along the new split axis the divider moves with its source edge; only
    // the perpendicular clipping belongs to the interrupted ancestor reveal.
    dividerClip[horizontal ? 1 : 0] = 0;
    dividerClip[horizontal ? 3 : 2] = 0;
    animate(divider.element, [{ transform: horizontal ? `translateX(${delta}px)` : `translateY(${delta}px)`, clipPath: inset(dividerClip) }, { transform: 'translate(0px, 0px)', clipPath: 'inset(0px)' }]);
  }
  function pause() { for (const animation of animations) animation.pause(); }
  function resume() { for (const animation of animations) if (animation.playState === 'paused') animation.play(); }
  return { prepare, play, finish, pause, resume };
}
