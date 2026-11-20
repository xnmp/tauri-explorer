"use strict";
/* =====================================================================================================
   MOVING AND RESIZING WINDOWS ON THE DESKTOP. Shared by the Explorer window (desktop.js, TXDesk.frame) and
   the programs a file opens in (host-apps.js), so every window on the page moves the same way.

     TXMove.*          pure geometry on bounds { x, y, w, h } in page (client) pixels: clamping, resizing from an
                       edge, edge snapping. No DOM; tests/site-desk-move.test.ts covers it.
     TXMove.gesture    the page-wide state of one move or resize: a transparent shield over every frame (so an
                       embedded app cannot swallow the pointer), the gesture's cursor, no text selection
     TXMove.attach     a press on a handle that turns into a gesture after a few pixels, coalesced to one
                       update per animation frame

   The desktop: `area` is the room under the top bar ({ left, top, right, bottom }). `reach` is where a title
   bar can still be grabbed: its right edge is the bench's left edge (a window may slide beneath the bench, but
   never so far that its title bar is lost under it) and its bottom the dock's top.
   ===================================================================================================== */
(function (root) {
  const MIN = Object.freeze({ w: 520, h: 360 });   // the Explorer stays usable: a pane, its toolbar and the tab strip
  const KEEP = Object.freeze({ x: 140, bar: 44 });  // of a window's title bar, always on the desktop: width, height
  const SNAP_EDGE = 6;                              // px from a screen edge that arms a snap
  const THRESHOLD = 4;                              // px a press travels before it is a drag

  const num = v => typeof v === "number" && Number.isFinite(v);
  const isBounds = b => !!b && num(b.x) && num(b.y) && num(b.w) && num(b.h);
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  const round = b => ({ x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) });
  const same = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

  /** Size within the desktop and no smaller than `min` (unless the desktop itself is smaller). */
  function clampSize(b, area, min = MIN) {
    const aw = Math.max(0, area.right - area.left), ah = Math.max(0, area.bottom - area.top);
    return { ...b, w: clamp(b.w, Math.min(min.w, aw), aw), h: clamp(b.h, Math.min(min.h, ah), ah) };
  }
  /** Position so the title bar stays grabbable: never above the desktop (under the top bar), never below the
      dock line, and at least KEEP.x of it inside [area.left, reach.right]. */
  function clampPosition(b, area, reach = area, keep = KEEP) {
    const kx = Math.min(keep.x, b.w);
    const right = Math.min(area.right, reach.right ?? area.right), bottom = Math.min(area.bottom, reach.bottom ?? area.bottom);
    return { ...b, x: clamp(b.x, area.left + kx - b.w, right - kx), y: clamp(b.y, area.top, bottom - keep.bar) };
  }
  const fit = (b, area, reach, min = MIN) => round(clampPosition(clampSize(b, area, min), area, reach));
  const moveBy = (b, dx, dy) => ({ ...b, x: b.x + dx, y: b.y + dy });

  /** Bounds after dragging `edge` (n, s, e, w or a corner such as "se") of `start` by (dx, dy). The opposite edge
      stays put; the moving edge stops at the minimum size and at the desktop's edge. */
  function resize(start, edge, dx, dy, area, min = MIN) {
    let { x, y, w, h } = start;
    const right = x + w, bottom = y + h;
    if (edge.includes("e")) w = clamp(w + dx, Math.min(min.w, area.right - x), area.right - x);
    if (edge.includes("s")) h = clamp(h + dy, Math.min(min.h, area.bottom - y), area.bottom - y);
    if (edge.includes("w")) { x = clamp(x + dx, area.left, right - min.w); w = right - x; }
    if (edge.includes("n")) { y = clamp(y + dy, area.top, bottom - min.h); h = bottom - y; }
    return round({ x, y, w, h });
  }

  /** Which snap a pointer at `p` arms while dragging a window: the top bar maximises, the screen's left or right
      edge takes that half. null: none. */
  function snapZone(p, area, edge = SNAP_EDGE) {
    if (!p || !num(p.x) || !num(p.y)) return null;
    if (p.x <= area.left + edge) return "left";
    if (p.x >= area.right - edge) return "right";
    if (p.y <= area.top + 2) return "max";
    return null;
  }
  /** A half of `work` (the desktop beside the bench), never narrower than `min.w`: on a narrow desktop the halves
      overlap rather than squeeze the app. */
  function halfOf(zone, work, gap = 16, min = MIN) {
    const ww = work.right - work.left, w = Math.min(ww, Math.max(min.w, Math.floor((ww - gap) / 2)));
    return round({ x: zone === "left" ? work.left : work.right - w, y: work.top, w, h: work.bottom - work.top });
  }
  /** A window of `size` that leaves a snapped or maximised one under the pointer: the pointer keeps its place along
      the title bar (as a fraction of the width) and its height in it. */
  function unsnapAt(p, cur, size) {
    const fx = cur.w > 0 ? clamp((p.x - cur.x) / cur.w, 0, 1) : .5;
    const dy = clamp(p.y - cur.y, 0, KEEP.bar);
    return round({ x: p.x - fx * size.w, y: p.y - dy, w: size.w, h: size.h });
  }
  const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, w: a.w + (b.w - a.w) * t, h: a.h + (b.h - a.h) * t });
  // quick, then a soft landing; no overshoot, which a resizing app would show as a jitter
  const settle = t => 1 - Math.pow(1 - clamp(t, 0, 1), 4);

  /* ---------------- DOM: one gesture at a time ---------------- */
  let active = null;
  /** Begin a page-wide gesture: a shield over everything (frames included) wearing `cursor`, no text selection.
      Returns end(). A second gesture ends the first. The pointer is always held by whoever started the gesture
      (a handle, or the app inside a frame), so the shield itself only ever sees a press or a release when that
      holder has gone without ending it (a frame reloaded mid-drag): then `abort` ends it, and the page is never
      left under a shield. */
  function gesture(cursor = "", abort = null) {
    active?.();
    const shield = document.createElement("div");
    shield.className = "desk-shield";
    if (cursor) shield.style.cursor = cursor;
    const orphaned = () => { if (active === end) { abort?.(); end(); } };
    shield.addEventListener("pointerdown", orphaned);
    shield.addEventListener("pointerup", orphaned);
    document.body.append(shield);
    document.body.classList.add("desk-gesture");
    const end = () => { if (active !== end) return; active = null; shield.remove(); document.body.classList.remove("desk-gesture"); };
    return active = end;
  }

  /** Presses on `handle` that `accept(e)` become a gesture after THRESHOLD px: begin(p) (return false to refuse),
      to(p) at most once a frame, end(p). p is { x, y } in client pixels. Mouse, pen and touch alike. */
  function attach(handle, { accept = () => true, begin, to, end, cursor = "" }) {
    let press = null;
    handle.addEventListener("pointerdown", e => {
      if (press || !e.isPrimary || e.button !== 0 || !accept(e)) return;
      press = { id: e.pointerId, x: e.clientX, y: e.clientY, live: false, raf: 0, last: null, done: null };
      // at once: a handle is thin, and the first move would otherwise land on whatever is beside it
      try { handle.setPointerCapture(e.pointerId); } catch (_) { /* gone already: pointerup ends it */ }
    });
    const flush = () => { if (!press) return; press.raf = 0; if (press.last) to(press.last); };
    handle.addEventListener("pointermove", e => {
      if (!press || e.pointerId !== press.id) return;
      const p = { x: e.clientX, y: e.clientY };
      if (!press.live) {
        if (Math.hypot(p.x - press.x, p.y - press.y) < THRESHOLD) return;
        if (begin({ x: press.x, y: press.y }) === false) {
          press = null;
          try { handle.releasePointerCapture(e.pointerId); } catch (_) { /* not held */ }
          return;
        }
        press.live = true;
        press.done = gesture(typeof cursor === "function" ? cursor() : cursor);
      }
      press.last = p;
      if (!press.raf) press.raf = requestAnimationFrame(flush);
    });
    const finish = e => {
      if (!press || e.pointerId !== press.id) return;
      const p = press;
      press = null;
      if (!p.live) return;
      cancelAnimationFrame(p.raf);
      const at = e.type === "pointerup" ? { x: e.clientX, y: e.clientY } : p.last || { x: p.x, y: p.y };
      to(at); p.done?.(); end(at);
    };
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
    handle.addEventListener("lostpointercapture", finish);
  }

  root.TXMove = { MIN, KEEP, SNAP_EDGE, THRESHOLD, isBounds, clampSize, clampPosition, fit, moveBy, resize, snapZone, halfOf, unsnapAt, lerp, settle, same, gesture, attach };
})(globalThis);
