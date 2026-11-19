"use strict";
/* =====================================================================================================
   THE DESKTOP the window sits on. Page-agnostic pieces, wired to the stage by workshop.html:
     TXDesk.wall      the wallpaper: one image per app theme (assets-desktop/wallpapers.js,
                      window.TX_WALLPAPERS = { [themeId]: { src, dark, avg, title } }), cross-faded on change,
                      with a generated backdrop from the theme's own colours while an image is missing or loading
     TXDesk.windowing the window's states: open, closed (the desktop shows), minimised (to the dock)
     TXDesk.platform  which download to offer first
   ===================================================================================================== */
(function () {
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------------- colour arithmetic on #rrggbb ---------------- */
  const rgb = h => { const n = parseInt(String(h).replace("#", "").slice(0, 6), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
  const hex = c => "#" + c.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
  const mix = (a, b, t) => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v + (y[i] - v) * t)); };
  const rgba = (h, a) => { const [r, g, b] = rgb(h); return `rgba(${r}, ${g}, ${b}, ${a})`; };

  /* ---------------- contour lines: the survey's own map, generated once ----------------
     Marching squares over a smooth field (a few summits and a valley), so the lines are true iso-lines that
     never cross. Every fifth is an index contour, drawn heavier, as on a printed sheet. The SVG is a mask: the
     page tints it with the theme's ink. */
  function contourMap({ w = 132, h = 84, levels = 15, seed = 41 } = {}) {
    let s = seed >>> 0;
    const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
    const peaks = [[.18, .30, .9, .22], [.72, .22, .75, .2], [.58, .78, -.8, .16], [.9, .7, .55, .17], [.32, .82, .45, .14]]
      .map(([x, y, a, r]) => [x + (rnd() - .5) * .06, y + (rnd() - .5) * .06, a, r]);
    const f = (x, y) => {
      let v = 0;
      for (const [px, py, a, r] of peaks) { const dx = (x - px) / (r * 1.6), dy = (y - py) / r; v += a * Math.exp(-(dx * dx + dy * dy)); }
      return v + .07 * Math.sin(x * 9.3 + y * 3.1) + .05 * Math.sin(y * 11.7 - x * 5.2) + .03 * Math.sin((x + y) * 23);
    };
    const F = []; let lo = Infinity, hi = -Infinity;
    for (let j = 0; j <= h; j++) { const row = []; for (let i = 0; i <= w; i++) { const v = f(i / w, j / h * (h / w) * 1.6); row.push(v); lo = Math.min(lo, v); hi = Math.max(hi, v); } F.push(row); }
    const S = 1200 / w, thin = [], thick = [];
    const lerp = (a, b, L) => (L - a) / (b - a);
    for (let k = 1; k < levels; k++) {
      const L = lo + (hi - lo) * k / levels, out = k % 5 === 0 ? thick : thin;
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        const a = F[j][i], b = F[j][i + 1], c = F[j + 1][i + 1], d = F[j + 1][i];
        const idx = (a > L ? 8 : 0) | (b > L ? 4 : 0) | (c > L ? 2 : 0) | (d > L ? 1 : 0);
        if (idx === 0 || idx === 15) continue;
        const T = [i + lerp(a, b, L), j], R = [i + 1, j + lerp(b, c, L)], B = [i + lerp(d, c, L), j + 1], Lf = [i, j + lerp(a, d, L)];
        const segs = { 1: [[Lf, B]], 2: [[B, R]], 3: [[Lf, R]], 4: [[T, R]], 5: [[Lf, T], [B, R]], 6: [[T, B]], 7: [[Lf, T]], 8: [[Lf, T]], 9: [[T, B]], 10: [[T, R], [Lf, B]], 11: [[T, R]], 12: [[Lf, R]], 13: [[B, R]], 14: [[Lf, B]] }[idx];
        for (const [p, q] of segs) out.push(`M${(p[0] * S).toFixed(1)} ${(p[1] * S).toFixed(1)}L${(q[0] * S).toFixed(1)} ${(q[1] * S).toFixed(1)}`);
      }
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 ${Math.round(h * S)}" preserveAspectRatio="xMidYMid slice"><g fill="none" stroke="#000" stroke-linecap="round"><path stroke-width="1" d="${thin.join("")}"/><path stroke-width="2.1" d="${thick.join("")}"/></g></svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  }

  /* ---------------- a backdrop from six theme colours ---------------- */
  // v = [paper, panel, ink, ink2, accent, folder]
  function generated(v, dark) {
    const [paper, side, ink, ink2, acc, folder] = v;
    if (dark) {
      const deep = mix(paper, "#000000", .38), floor = mix(mix(side, acc, .12), "#000000", .2);
      return [
        `radial-gradient(58% 62% at 14% 8%, ${rgba(acc, .55)}, transparent 70%)`,
        `radial-gradient(46% 50% at 92% 96%, ${rgba(folder, .42)}, transparent 72%)`,
        `linear-gradient(118deg, transparent 28%, ${rgba(acc, .14)} 44%, ${rgba(folder, .12)} 56%, transparent 72%)`,
        `radial-gradient(80% 70% at 66% 30%, ${rgba(ink2, .14)}, transparent 76%)`,
        `linear-gradient(168deg, ${deep}, ${floor} 52%, ${mix(paper, "#000000", .5)})`,
      ].join(", ");
    }
    const sky = mix(paper, acc, .16), snow = mix(paper, "#ffffff", .5);
    return [
      `radial-gradient(56% 60% at 12% 6%, ${rgba(acc, .42)}, transparent 70%)`,
      `radial-gradient(48% 52% at 94% 94%, ${rgba(folder, .46)}, transparent 72%)`,
      `linear-gradient(118deg, transparent 26%, ${rgba(acc, .12)} 44%, ${rgba(folder, .14)} 58%, transparent 74%)`,
      `radial-gradient(70% 60% at 60% 34%, ${rgba(snow, .7)}, transparent 76%)`,
      `linear-gradient(168deg, ${sky}, ${mix(side, ink, .08)} 55%, ${mix(mix(side, acc, .1), ink, .16)})`,
    ].join(", ");
  }

  /* ---------------- the wallpaper ---------------- */
  // The registry is optional: without it (or an entry) the conventional path is tried, then the generated backdrop.
  const resolveSrc = src => new URL(/[/:]/.test(src) ? src : "assets-desktop/" + src, location.href).href;
  function entryFor(key) {
    const reg = window.TX_WALLPAPERS || {};
    if (typeof key !== "string" || /^site-|^custom/.test(key)) return null;   // custom colours: always generated
    const e = reg[key];
    if (e && e.src) return { src: resolveSrc(e.src), dark: e.dark, avg: e.avg, title: e.title || "" };
    return window.TX_WALLPAPERS ? null : { src: resolveSrc(`assets-desktop/${key}.webp`), title: "" };
  }
  const loaded = new Map();   // src → Promise<boolean>
  function preload(src, ms = 6000) {
    if (!loaded.has(src)) loaded.set(src, new Promise(res => {
      const im = new Image(); let done = false; const end = ok => { if (!done) { done = true; res(ok); } };
      im.onload = () => (im.decode ? im.decode().catch(() => {}) : Promise.resolve()).then(() => end(true));
      im.onerror = () => end(false);
      setTimeout(() => end(false), ms);
      im.src = src;
    }).then(ok => { if (!ok) loaded.delete(src); return ok; }));
    return loaded.get(src);
  }

  function makeWall(root, { onDress } = {}) {
    const layers = [...root.querySelectorAll(".wl")], contour = root.querySelector(".contour");
    if (contour) { const m = contourMap(); contour.style.webkitMaskImage = m; contour.style.maskImage = m; }
    let front = 0, seq = 0, shownKey = "";
    function put(bg, { image, dark, avg, title, key }) {
      const back = layers[1 - front], cur = layers[front];
      const k = key + "|" + bg;
      if (k === shownKey) return;
      shownKey = k;
      back.style.background = bg;
      back.dataset.kind = image ? "image" : "generated";
      root.dataset.kind = image ? "image" : "generated";
      onDress?.({ dark, avg, title, image });
      const instant = reduced() || !cur.style.background;
      back.style.transition = "none"; back.style.opacity = instant ? "1" : "0"; back.style.zIndex = "2"; cur.style.zIndex = "1";
      back.getBoundingClientRect();
      if (!instant) { back.style.transition = ""; back.style.opacity = "1"; }
      const mine = front = 1 - front;
      setTimeout(() => { if (front === mine) { cur.style.transition = "none"; cur.style.opacity = "0"; } }, instant ? 0 : 700);
    }
    // Show the theme now: its generated backdrop at once (or straight to the image when it is already decoded),
    // the image cross-fading in once it has loaded and decoded. A later call wins over a slower earlier one.
    // `explicit` ({ src, dark, avg, title }) names the image directly: an Omarchy theme's own, or a machine's own desktop.
    // When it fails to load, `key`'s registered wallpaper is tried instead, so pass the theme id as the key.
    async function show(key, palette, explicit) {
      const my = ++seq, v = palette.v, dark = !!palette.dark;
      const e = explicit && explicit.src ? { ...explicit, src: resolveSrc(explicit.src) } : entryFor(key);
      const gen = generated(v, dark), genDress = { dark, avg: mix(v[0], v[4], .18), title: "", key };
      const ready = e && loaded.has(e.src) ? await Promise.race([loaded.get(e.src), new Promise(r => setTimeout(() => r(null), 30))]) : null;
      if (my !== seq) return;
      const imgDress = e && { image: true, key, dark: e.dark ?? dark, avg: e.avg || genDress.avg, title: e.title };
      if (ready) return put(`url("${e.src}") center / cover no-repeat, ${gen}`, imgDress);
      put(gen, genDress);
      if (!e) return;
      const ok = await preload(e.src);
      if (my !== seq) return;
      if (ok) return put(`url("${e.src}") center / cover no-repeat, ${gen}`, imgDress);
      // a named picture that is missing (still being made, say) falls back to the theme's own wallpaper
      const f = explicit ? entryFor(key) : null;
      if (f && f.src !== e.src && await preload(f.src) && my === seq)
        put(`url("${f.src}") center / cover no-repeat, ${gen}`, { image: true, key, dark: f.dark ?? dark, avg: f.avg || genDress.avg, title: f.title });
    }
    return { show };
  }

  /* ---------------- the window: open, closed, minimised ----------------
     The frame is never destroyed: closing hides it (tabs, path and settings survive), opening shows it again.
     Animations are FLIPs of the stage element between its rect and an icon's. */
  function makeWindowing({ stage, iconRect, dockRect, onChange }) {
    let state = "open", anim = null;
    const flip = (from, r) => {
      if (!from || !r.width) return "translateY(14px) scale(.96)";
      const s = Math.max(.04, Math.min(1, (from.width * 1.8) / r.width));
      const dx = from.left + from.width / 2 - (r.left + r.width / 2), dy = from.top + from.height / 2 - (r.top + r.height / 2);
      return `translate(${dx}px, ${dy}px) scale(${s})`;
    };
    const run = (frames, opts) => {
      anim?.cancel();
      if (reduced()) return Promise.resolve();
      anim = stage.animate(frames, { fill: "none", ...opts });
      return anim.finished.catch(() => {}).then(() => { anim = null; });
    };
    function set(next) { const was = state; state = next; stage.classList.toggle("away", next !== "open"); stage.inert = next !== "open"; onChange?.(next, was); }
    async function away(next) {
      if (state !== "open") { if (state !== next) set(next); return; }
      const r = stage.getBoundingClientRect();
      const to = next === "minimized" ? flip(dockRect?.(), r) : "translateY(10px) scale(.94)";
      set(next);   // the bench and dock answer at once; the window finishes leaving on its own
      stage.classList.add("leaving");
      await run([{ transform: "none", opacity: 1 }, { transform: to, opacity: 0 }],
        next === "minimized" ? { duration: 380, easing: "cubic-bezier(.55, .05, .7, .2)" } : { duration: 210, easing: "cubic-bezier(.4, 0, .9, .4)" });
      stage.classList.remove("leaving");
    }
    async function open() {
      if (state === "open") return;
      const was = state;
      set("open");
      const r = stage.getBoundingClientRect();
      const from = flip(was === "minimized" ? dockRect?.() : iconRect?.(), r);
      await run([{ transform: from, opacity: 0, offset: 0 }, { opacity: 1, offset: .45 }, { transform: "none", opacity: 1 }],
        { duration: was === "minimized" ? 420 : 460, easing: "cubic-bezier(.18, .9, .22, 1.04)" });
    }
    return { close: () => away("closed"), minimize: () => away("minimized"), open, get state() { return state; } };
  }

  /* ---------------- which build to offer first ---------------- */
  function platform() {
    const p = String((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "") + " " + navigator.userAgent;
    if (/android|iphone|ipad|ipod/i.test(p)) return null;   // nothing to install there: offer the release page
    if (/mac/i.test(p)) return { id: "macos", name: "macOS" };
    if (/win/i.test(p)) return { id: "windows", name: "Windows" };
    if (/linux|x11|cros|bsd/i.test(p)) return { id: "linux", name: "Linux" };
    return null;
  }

  window.TXDesk = { wall: makeWall, windowing: makeWindowing, platform, generated, contourMap, mix };
})();
