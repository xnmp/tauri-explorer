"use strict";
/* =====================================================================================================
   THE GUIDE'S RULES. One list of steps shared by the desktop's "Try this" checklist and the phone's tour,
   and the pure decisions behind both: which bridge event completes which step, the visitor's progress, where
   a hint may sit without covering what it points at, and which detent a dragged bottom sheet settles on.
   No DOM; tests/site-guide.test.ts covers it. guide.js draws it; workshop.html feeds it the app's events.
   ===================================================================================================== */
(function (root) {
  /* ---------------- the steps ----------------
     `core`: on the desktop checklist (five); every step is on the phone tour, in this order (the page drops one
     the machine cannot show, such as the commit graph where there is no repository).
     `keys`: the command whose key the row shows (the page looks the key up, so a rebound key shows as rebound).
     `line`: the checklist row's explanation. `did`: said once "Show me" has done it in the live window ({name}: what
     it did). `tour`: the phone tour's caption, said after "Next" has done the step. */
  const STEPS = Object.freeze([
    { id: "goto", core: true, title: "Jump to a file", keys: "general.openQuickOpen",
      line: "Press the keys, type part of a name, then Enter. No clicking through folders.",
      did: "Quick Open is open in the window. Type a few letters of any file name.",
      tour: "Quick Open finds any file from part of its name. On a computer it is Ctrl+P." },
    { id: "view", core: false, title: "Change the view",
      tour: "The same folder as tiles. Details, list and tiles: each pane keeps its own." },
    { id: "theme", core: true, title: "Change the theme",
      line: "Pick colours on the bench. The desktop changes with them.",
      did: "Now in {name}. The whole desktop changed with it.",
      tour: "A new theme dresses the whole window. There are dozens, and you can make your own." },
    { id: "panel", core: true, title: "Turn a panel on or off",
      line: "Every part of the window is optional. Try Preview or Sidebar on the bench.",
      did: "The preview is on: it shows the selected file beside the list.",
      tour: "A terminal under the files, already in this folder. Every panel is optional." },
    { id: "graph", core: false, title: "See a project's history",
      tour: "The commit graph: every branch of this project's history, drawn as it happened." },
    { id: "setup", core: true, title: "Try a ready-made setup",
      line: "The Shelf has whole windows made for someone: photographers, git users, two-pane fans.",
      did: "Wearing {name}: theme, layout, panels and keys in one go.",
      tour: "A ready-made setup: theme, layout and view in one tap." },
    { id: "machine", core: true, title: "Switch machine",
      line: "Three computers, three stories, each with its own files and look.",
      did: "Pick a machine. The window opens again on its files.",
      tour: "Three computers, three stories. Pick one and the window opens on it." },
  ]);
  const CORE = STEPS.filter(s => s.core).map(s => s.id);
  const TOUR = STEPS.map(s => s.id);
  const byId = id => STEPS.find(s => s.id === id) || null;

  /* ---------------- progress ----------------
     { v: 1, done: [ids], welcomed, open, dismissed, firstFs }: `open` is the checklist unfolded, `dismissed` the
     checklist put away (the "?" button brings it back). Anything malformed in storage reads as a fresh visit. */
  const FRESH = Object.freeze({ v: 1, done: [], welcomed: false, open: false, dismissed: false, firstFs: null });
  function readProgress(raw) {
    let o = raw;
    if (typeof raw === "string") { try { o = JSON.parse(raw); } catch (_) { o = null; } }
    if (!o || typeof o !== "object" || Array.isArray(o) || o.v !== 1) return { ...FRESH, done: [] };
    const done = Array.isArray(o.done) ? [...new Set(o.done.filter(id => typeof id === "string" && byId(id)))] : [];
    return {
      v: 1, done,
      welcomed: o.welcomed === true, open: o.open === true, dismissed: o.dismissed === true,
      firstFs: typeof o.firstFs === "string" && /^[a-z0-9-]{1,40}$/.test(o.firstFs) ? o.firstFs : null,
    };
  }
  const isDone = (p, id) => p.done.includes(id);
  const markDone = (p, id) => !byId(id) || isDone(p, id) ? p : { ...p, done: [...p.done, id] };
  const coreCount = p => CORE.filter(id => isDone(p, id)).length;
  const allCore = p => coreCount(p) === CORE.length;
  /** The first core step not yet done, or null. */
  const nextCore = p => CORE.find(id => !isDone(p, id)) || null;

  /* ---------------- which event completes which step ----------------
     `e` is one observation, made by the page from a bridge event or the app's state:
       { type: "overlay", kind }                       the app's `overlay` event (`kind`: quick-open, command-palette, …)
       { type: "panels", before, after, cause }        two `panels` states
       { type: "theme", before, after, cause }         the theme setting, before and after
       { type: "view", before, after }                 the active pane's view mode
       { type: "setup", id }                           the window now wears a shelf setup (`id` null: none)
       { type: "machine", here, first }                the machine in the drive, and the first one this visitor had
     `cause` "page" marks a change the page itself made as part of fitting a whole setup or starting up: that is the
     setup step's, not a panel's or a theme's. Returns the ids the observation completes. */
  const PANEL_KEYS = ["sidebar", "address", "status", "preview", "terminal", "split", "miller", "scm", "git"];
  function completes(e) {
    if (!e || typeof e !== "object") return [];
    switch (e.type) {
      case "overlay": return e.kind === "quick-open" ? ["goto"] : [];
      case "panels": {
        if (e.cause === "page" || !e.before || !e.after) return [];
        return PANEL_KEYS.some(k => !!e.before[k] !== !!e.after[k]) ? ["panel"] : [];
      }
      case "theme": {
        if (e.cause === "page" || e.before == null || e.after == null) return [];
        return JSON.stringify(e.before) !== JSON.stringify(e.after) ? ["theme"] : [];
      }
      case "view": return e.before && e.after && e.before !== e.after ? ["view"] : [];
      case "setup": return typeof e.id === "string" && e.id ? ["setup"] : [];
      case "machine": return typeof e.here === "string" && typeof e.first === "string" && e.here !== e.first ? ["machine"] : [];
      default: return [];
    }
  }
  const observe = (p, e) => completes(e).reduce(markDone, p);

  /** Is this arrival one the welcome card should greet? Never a returning visitor, a shared setup, or someone mid-story. */
  function shouldWelcome(p, { sharedSetup = false, arriving = false, midStory = false } = {}) {
    return !p.welcomed && !sharedSetup && !arriving && !midStory;
  }

  /* ---------------- a hint beside what it points at ----------------
     `target` and `avoid` are rects { x, y, w, h } on the page, `size` the hint's { w, h }, `view` the room
     { left, top, right, bottom }. Tries each side in `order` (default below, above, right, left); the first where the
     hint fits inside the room, clear of the target and of every `avoid` rect by `gap`, wins. Centred on the target
     along that side, then slid to stay in the room. Null when no side fits: the caller shows nothing rather than
     cover the thing. */
  const hits = (a, b, pad = 0) => a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
  const clampN = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  const okRect = r => !!r && [r.x, r.y, r.w, r.h].every(v => typeof v === "number" && Number.isFinite(v)) && r.w >= 0 && r.h >= 0;
  function placeHint(target, size, view, { gap = 10, order = ["below", "above", "right", "left"], avoid = [] } = {}) {
    if (!okRect(target) || !size || !(size.w > 0) || !(size.h > 0) || !view) return null;
    const room = { x: view.left, y: view.top, w: view.right - view.left, h: view.bottom - view.top };
    if (!(room.w >= size.w) || !(room.h >= size.h)) return null;
    for (const side of order) {
      let x, y;
      if (side === "below" || side === "above") {
        x = clampN(target.x + target.w / 2 - size.w / 2, room.x + 4, room.x + room.w - size.w - 4);
        y = side === "below" ? target.y + target.h + gap : target.y - gap - size.h;
      } else {
        y = clampN(target.y + target.h / 2 - size.h / 2, room.y + 4, room.y + room.h - size.h - 4);
        x = side === "right" ? target.x + target.w + gap : target.x - gap - size.w;
      }
      const r = { x, y, w: size.w, h: size.h };
      const inside = r.x >= room.x && r.y >= room.y && r.x + r.w <= room.x + room.w && r.y + r.h <= room.y + room.h;
      if (!inside || hits(r, target) || avoid.filter(okRect).some(a => hits(r, a))) continue;
      // where the hint's arrow meets the target, along the hint's edge (px from its left or top)
      const arrow = side === "below" || side === "above"
        ? clampN(target.x + target.w / 2 - x, 14, size.w - 14) : clampN(target.y + target.h / 2 - y, 14, size.h - 14);
      return { x: Math.round(x), y: Math.round(y), side, arrow: Math.round(arrow) };
    }
    return null;
  }

  /* ---------------- the bottom sheet's detents ----------------
     `detents`: the sheet's visible heights, ascending (px). A release settles on the nearest detent to the height
     it was let go at, carried on by its speed (`velocity`, px/ms, positive = growing) for FLING_MS; a quick flick
     goes at least one detent in its direction. */
  const FLING_MS = 180, FLICK = 0.45;
  function settleDetent(detents, height, velocity = 0) {
    const d = (Array.isArray(detents) ? detents : []).filter(n => typeof n === "number" && Number.isFinite(n)).sort((a, b) => a - b);
    if (!d.length) return 0;
    const h = Number.isFinite(height) ? height : d[0], v = Number.isFinite(velocity) ? velocity : 0;
    const aim = h + v * FLING_MS;
    let i = d.reduce((best, n, k) => Math.abs(n - aim) < Math.abs(d[best] - aim) ? k : best, 0);
    if (Math.abs(v) >= FLICK) {   // a flick never comes back to where it started
      const from = d.reduce((best, n, k) => Math.abs(n - h) < Math.abs(d[best] - h) ? k : best, 0);
      if (v > 0 && i <= from && d[from] <= h + 1) i = Math.min(d.length - 1, from + 1);
      if (v < 0 && i >= from && d[from] >= h - 1) i = Math.max(0, from - 1);
    }
    return i;
  }
  /** A tap on the handle: up one detent, and from the top back to the bottom. */
  const nextDetent = (count, at) => (count > 0 ? ((Number.isInteger(at) ? at : 0) + 1) % count : 0);
  /** Dragging past the ends resists: half the overshoot, at most `limit` px. */
  function rubber(height, min, max, limit = 40) {
    if (height < min) return min - Math.min(limit, (min - height) / 2);
    if (height > max) return max + Math.min(limit, (height - max) / 2);
    return height;
  }

  root.TXGuideCore = Object.freeze({
    STEPS, CORE, TOUR, byId, FRESH,
    readProgress, isDone, markDone, coreCount, allCore, nextCore,
    completes, observe, shouldWelcome,
    placeHint, settleDetent, nextDetent, rubber,
  });
})(typeof window !== "undefined" ? window : globalThis);
