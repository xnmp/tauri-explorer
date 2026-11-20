"use strict";
/* =====================================================================================================
   THE PHONE. On a narrow touch screen the window fills the screen and the bench becomes a bottom sheet: a grab
   handle, three detents (the tour or a one-line invitation; the look; everything), big tap targets. The tour walks
   the same steps as the desktop checklist (guide-core.js), and each "Next" does one in the live window, in place
   of the keyboard shortcuts a phone cannot press. workshop.html fills the sheet and does the steps.

     TXPhone.QUERY                 the media query that means "phone" (also set as html.phone before first paint)
     TXPhone.mount(api) → phone
       api.steps                   [{ id, title, tour }] the tour's steps, in order (only those this machine can show)
       api.run(id)                 does the step in the live window → { caption? } | null
       api.fill(body)              puts the sheet's sections into `body`
       api.send()                  the call to action: share or copy this page's link
       api.guide                   the guide (progress, markWelcomed)
       api.clear()                 closes what a step opened outside the window (the machines picker)
       api.welcome                 this arrival is greeted with the tour's first card
       api.onDetent(i)             the sheet settled (0 peek, 1 half, 2 full)
     phone.intro()                 the tour from its first card (the "?" button)
     phone.detent(i)               move the sheet
     phone.on                      the tour is showing
   ===================================================================================================== */
(function () {
  const C = window.TXGuideCore;
  const QUERY = "(max-width: 600px), (max-height: 500px) and (pointer: coarse)";
  const TOUR_KEY = "tx-workshop-tour-v1";   // sessionStorage: the tour survives switching machine (a reload)
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const ICON_X = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`;
  const ICON_UP = `<svg viewBox="0 0 12 12" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="m3 7.5 3-3 3 3"/></svg>`;
  const ICON_SEND = `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="M8 10V2.5M5 5.3 8 2.3l3 3M3.5 8.5v4c0 .6.4 1 1 1h7c.6 0 1-.4 1-1v-4"/></svg>`;

  const readTour = () => { try { const o = JSON.parse(sessionStorage.getItem(TOUR_KEY) || "null"); return o && typeof o === "object" && Number.isInteger(o.at) ? o : null; } catch (_) { return null; } };
  const writeTour = o => { try { if (o) sessionStorage.setItem(TOUR_KEY, JSON.stringify(o)); else sessionStorage.removeItem(TOUR_KEY); } catch (_) { /* this page only */ } };

  function mount(api) {
    const steps = api.steps, N = steps.length;
    const sheet = document.createElement("section");
    sheet.className = "ph-sheet"; sheet.id = "ph-sheet";
    sheet.setAttribute("role", "region"); sheet.setAttribute("aria-label", "Tour and settings");
    sheet.innerHTML = `<button class="ph-handle" type="button" aria-controls="ph-body" aria-expanded="false"><i aria-hidden="true"></i><span class="sr" id="ph-handle-t">Show more settings</span></button>
      <div class="ph-peek" id="ph-peek"></div>
      <div class="ph-body" id="ph-body"></div>`;
    document.body.append(sheet);
    const handle = sheet.querySelector(".ph-handle"), peek = sheet.querySelector("#ph-peek"), body = sheet.querySelector("#ph-body");
    api.fill(body);

    /* ---- the tour ---- */
    // at: -1 the first card, 0..N-1 a step done, N the last card. `on`: the tour shows in the peek.
    const saved = readTour();
    let tour = saved ? { on: !!saved.on, at: Math.max(-1, Math.min(N, saved.at)) } : { on: !!api.welcome, at: -1 };
    // back from another machine on the tour's last step: the machine step is done
    if (saved && saved.on && steps[tour.at] && steps[tour.at].id === "machine" && C.isDone(api.guide.progress, "machine")) tour.at = N;
    let caption = saved && saved.caption || "", running = false;
    const keep = () => writeTour(tour.on ? { ...tour, caption } : null);

    function dots() { return `<span class="ph-dots" aria-hidden="true">${steps.map((s, i) => `<i class="${i <= tour.at ? "on" : ""}${i === tour.at ? " cur" : ""}"></i>`).join("")}</span>`; }
    function paintPeek() {
      if (!tour.on) {
        peek.innerHTML = `<div class="ph-explore">
          <button class="ph-open" type="button" data-up><span class="ph-sw" aria-hidden="true">${api.swatch ? api.swatch() : ""}</span><span class="ph-ot"><b>Make it yours</b><small>Colours, layouts, setups</small></span><span class="ph-chev" aria-hidden="true">${ICON_UP}</span></button>
          <button class="ph-tour-again" type="button" data-intro>Tour</button></div>`;
        return;
      }
      const intro = tour.at < 0, end = tour.at >= N, s = steps[tour.at];
      const title = intro ? "This is Tauri Explorer" : end ? "That is the tour" : s.title;
      const text = intro ? "A file explorer you can make your own. This is the real app, running live in your browser."
        : end ? "Tauri Explorer runs on Linux, macOS and Windows. Send this page to your computer to get it." : (caption || s.tour);
      const label = intro ? "Tour, start" : end ? "Tour, end" : `Tour, step ${tour.at + 1} of ${N}`;
      const next = intro ? "Start the tour" : end ? "" : tour.at === N - 1 ? "Finish" : "Next";
      peek.innerHTML = `<div class="ph-tour${intro ? " intro" : ""}${end ? " end" : ""}" role="group" aria-label="${label}">
        <div class="ph-tour-top">${intro ? `<img src="assets-desktop/app-icon.png" alt="" width="30" height="30">` : dots()}<span class="ph-n">${intro ? "Live demo" : end ? "Done" : `${tour.at + 1} of ${N}`}</span>
          <button class="ph-x" type="button" data-leave aria-label="Leave the tour">${ICON_X}</button></div>
        <h2>${esc(title)}</h2>
        <p aria-live="polite">${esc(text)}</p>
        <div class="ph-acts">${intro ? `<button class="btn ph-ghost" type="button" data-leave>Look around</button>` : end ? `<button class="btn ph-ghost" type="button" data-leave>Done</button>` : `<button class="btn ph-ghost" type="button" data-back>Back</button>`}
          ${end ? `<button class="btn primary" type="button" data-send>${ICON_SEND}<span>Send this to my computer</span></button>` : `<button class="btn primary" type="button" data-next${running ? " disabled" : ""}>${next}</button>`}</div>
      </div>`;
    }
    async function go(at) {
      if (running) return;
      tour.at = Math.max(-1, Math.min(N, at)); caption = "";
      if (tour.at >= 0 && tour.at < N) {
        running = true; paintPeek(); measure();
        let res = null;
        try { res = await api.run(steps[tour.at].id); } catch (e) { console.warn("workshop: a tour step failed", e); }
        running = false;
        caption = res && res.caption || "";
      } else api.clear?.();   // the intro and the end: nothing the tour opened stays open
      keep(); paintPeek(); measure();
      const next = peek.querySelector("[data-next]") || peek.querySelector("[data-send]"); if (next) next.focus({ preventScroll: true, focusVisible: false });
    }
    function leave() {
      tour = { on: false, at: -1 }; caption = ""; keep();
      api.guide.markWelcomed(); api.clear?.();
      paintPeek(); measure();
      peek.querySelector("[data-up]")?.focus({ preventScroll: true, focusVisible: false });
    }
    peek.addEventListener("click", e => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.hasAttribute("data-next")) { if (tour.at < 0) api.guide.markWelcomed(); go(tour.at + 1); }
      else if (b.hasAttribute("data-back")) go(tour.at - 1);
      else if (b.hasAttribute("data-leave")) leave();
      else if (b.hasAttribute("data-send")) api.send(b);
      else if (b.hasAttribute("data-intro")) intro();
      else if (b.hasAttribute("data-up")) detent(at === 0 ? 1 : 0);
    });
    function intro() { tour = { on: true, at: -1 }; caption = ""; keep(); detent(0); paintPeek(); measure(); peek.querySelector("[data-next]")?.focus({ preventScroll: true }); }

    /* ---- the sheet: three detents, dragged by the handle and the peek ---- */
    let at = 0, H = [0, 0, 0], drag = null, raf = 0;
    const root = document.documentElement;
    function heights() {
      const vh = innerHeight, top = document.querySelector(".strip")?.getBoundingClientRect().bottom || 56;
      const peekH = Math.ceil(handle.offsetHeight + peek.offsetHeight + (parseFloat(getComputedStyle(sheet).paddingBottom) || 0));
      const full = Math.max(peekH + 80, Math.round(vh - top - 6));
      const half = Math.max(peekH + 40, Math.min(full - 60, Math.round(vh * (vh < 500 ? .62 : .54))));
      return [peekH, half, full];
    }
    function paint(h, animate) {
      sheet.style.height = H[2] + "px";
      sheet.classList.toggle("moving", !animate);
      sheet.style.transform = `translateY(${Math.round(H[2] - h)}px)`;
      body.style.height = Math.max(0, h - H[0]) + "px";   // only what shows scrolls, so the last section is reachable at every detent
    }
    function measure() {
      H = heights();
      root.style.setProperty("--ph-peek", H[0] + "px");
      paint(H[at], false);
      requestAnimationFrame(() => sheet.classList.remove("moving"));
    }
    function detent(i, { focus = false } = {}) {
      at = Math.max(0, Math.min(2, i));
      paint(H[at], !reduced());
      sheet.dataset.at = at;
      handle.setAttribute("aria-expanded", String(at > 0));
      sheet.querySelector("#ph-handle-t").textContent = at === 2 ? "Show less" : at === 1 ? "Show everything" : "Show more settings";
      body.inert = at === 0;
      if (at === 0) body.scrollTop = 0;
      api.onDetent?.(at);
      if (focus && at > 0) body.querySelector("button, [href]")?.focus({ preventScroll: true });
    }
    handle.addEventListener("click", () => { if (!handle._dragged) detent(C.nextDetent(3, at)); handle._dragged = false; });
    handle.addEventListener("keydown", e => {
      if (e.key === "ArrowUp") { e.preventDefault(); detent(at + 1); }
      else if (e.key === "ArrowDown") { e.preventDefault(); detent(at - 1); }
    });
    const startDrag = e => {
      if (e.button !== 0 || (e.target.closest("button, a, input") && e.target.closest(".ph-handle") !== handle)) return;
      const h0 = H[at];
      drag = { id: e.pointerId, y0: e.clientY, h0, h: h0, t: e.timeStamp, v: 0, moved: false, el: e.currentTarget };
    };
    const moveDrag = e => {
      if (!drag || e.pointerId !== drag.id) return;
      const dy = e.clientY - drag.y0;
      if (!drag.moved && Math.abs(dy) < 6) return;
      if (!drag.moved) { drag.moved = true; try { drag.el.setPointerCapture(e.pointerId); } catch (_) { /* gone */ } }
      const h = C.rubber(drag.h0 - dy, H[0], H[2]), dt = Math.max(1, e.timeStamp - drag.t);
      drag.v = .7 * ((h - drag.h) / dt) + .3 * drag.v; drag.h = h; drag.t = e.timeStamp;
      cancelAnimationFrame(raf); raf = requestAnimationFrame(() => paint(drag ? drag.h : H[at], false));
    };
    const endDrag = e => {
      if (!drag || e.pointerId !== drag.id) return;
      const d = drag; drag = null;
      if (!d.moved) return;
      handle._dragged = true; setTimeout(() => { handle._dragged = false; }, 0);
      detent(C.settleDetent(H, d.h, e.type === "pointercancel" ? 0 : d.v));
    };
    for (const el of [handle, peek]) {
      el.addEventListener("pointerdown", startDrag);
      el.addEventListener("pointermove", moveDrag);
      el.addEventListener("pointerup", endDrag);
      el.addEventListener("pointercancel", endDrag);
    }
    addEventListener("resize", () => measure());
    try { new ResizeObserver(() => measure()).observe(peek); } catch (_) { /* resize covers it */ }

    paintPeek(); measure(); detent(0);
    if (tour.on && tour.at >= N) { keep(); }
    return {
      intro,
      detent: i => detent(i),
      get at() { return at; },
      get on() { return tour.on; },
      repaint: () => { if (!tour.on) { paintPeek(); measure(); } },
    };
  }

  window.TXPhone = { QUERY, mount };
})();
