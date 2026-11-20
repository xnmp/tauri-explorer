"use strict";
/* =====================================================================================================
   THE GUIDE: one voice for a newcomer. The welcome card, the "Try this" checklist and its "Show me" cues, the
   tooltips on the bench, and the phone's tour all read one list of steps (guide-core.js, TXGuideCore). The page
   (workshop.html) does the steps in the live window and reports what the app did; the guide only draws.

     TXGuide.mount(api) → guide
       api.allowWelcome   this arrival may be greeted (not a shared setup, not mid-story)
       api.keyHTML(id)    the command's key as keycaps, or ""
       api.download       { label, href } the top bar's download
       api.doStep(id)     does a step in the live window → { target?: Element, name?: string } | null
       api.busy()         the story has the floor (a file open, the machine picker, the finale): stay quiet
       api.fsId           the machine in the drive (the switch-machine step compares it with the first one)
       api.phone()        the phone layout is on (no welcome card or checklist: the tour does their work)
     guide.observe(e)     an observation (TXGuideCore.completes); ticks what it completes
     guide.welcome()      the "?" button: the welcome card again (desktop) or the tour's start (phone)
     guide.quiet()        true while the guide has something on screen: other hints wait
     guide.tips(root)     gives every [data-tip] under root its description (aria-describedby) once
   ===================================================================================================== */
(function () {
  const C = window.TXGuideCore;
  const STORE = "tx-workshop-guide-v1";
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const ICON_DL = `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M8 2.5v8m-3.3-3.2L8 10.6l3.3-3.3M3 13.5h10"/></svg>`;
  const ICON_X = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;
  const ICON_TICK = `<svg viewBox="0 0 12 12" aria-hidden="true"><path d="m2.6 6.3 2.2 2.2 4.6-4.9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const ICON_CHEV = `<svg viewBox="0 0 12 12" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="m3 7.5 3-3 3 3"/></svg>`;

  function load() { try { return C.readProgress(localStorage.getItem(STORE)); } catch (_) { return C.readProgress(null); } }
  function save(p) { try { localStorage.setItem(STORE, JSON.stringify(p)); } catch (_) { /* storage blocked: progress lasts this visit */ } }

  /* ---------------- tooltips: plain words for controls a newcomer will not know ---------------- */
  // One tooltip element for the page. Mouse: after a short rest on the control. Keyboard: on focus. Touch: a moment
  // after the tap, so the explanation follows the change it explains. Every [data-tip] also gets the text as its
  // accessible description, so a screen reader hears it without the tooltip.
  function makeTips() {
    const tip = document.createElement("div");
    tip.className = "gd-tip glass"; tip.setAttribute("role", "tooltip"); tip.id = "gd-tip"; tip.hidden = true;
    const store = document.createElement("div"); store.hidden = true; store.id = "gd-tip-texts";
    document.body.append(tip, store);
    let n = 0, showT = 0, hideT = 0, cur = null, warmUntil = 0;
    function describe(root = document) {
      for (const el of root.querySelectorAll("[data-tip]")) {
        const text = el.dataset.tip;
        let id = el.dataset.tipId;
        if (!id) { id = el.dataset.tipId = "gd-tx-" + (++n); const s = document.createElement("span"); s.id = id; store.append(s); }
        const s = document.getElementById(id); if (s && s.textContent !== text) s.textContent = text;
        const ids = (el.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
        if (!ids.includes(id)) el.setAttribute("aria-describedby", [...ids, id].join(" "));
        el.removeAttribute("title");
      }
    }
    function place(el) {
      const r = el.getBoundingClientRect();
      tip.style.left = "0px"; tip.style.top = "0px";
      const size = { w: tip.offsetWidth, h: tip.offsetHeight };
      const at = C.placeHint({ x: r.left, y: r.top, w: r.width, h: r.height }, size, { left: 8, top: 8, right: innerWidth - 8, bottom: innerHeight - 8 }, { gap: 8, order: ["above", "below", "left", "right"] });
      if (!at) { hide(); return false; }
      tip.style.left = at.x + "px"; tip.style.top = at.y + "px"; tip.dataset.side = at.side; tip.style.setProperty("--arrow", at.arrow + "px");
      return true;
    }
    function show(el, { ms = 0 } = {}) {
      clearTimeout(showT); clearTimeout(hideT);
      if (!el.isConnected || !el.dataset.tip || document.body.classList.contains("desk-gesture")) return;
      cur = el; tip.textContent = el.dataset.tip; tip.hidden = false; tip.classList.remove("on");
      if (!place(el)) return;
      requestAnimationFrame(() => tip.classList.add("on"));
      if (ms) hideT = setTimeout(hide, ms);
    }
    function hide() { clearTimeout(showT); clearTimeout(hideT); if (!tip.hidden) warmUntil = performance.now() + 400; cur = null; tip.classList.remove("on"); tip.hidden = true; }
    const owner = e => e.target.closest?.("[data-tip]");
    document.addEventListener("pointerover", e => {
      if (e.pointerType !== "mouse") return;
      const el = owner(e); if (!el || el === cur) return;
      clearTimeout(showT);
      showT = setTimeout(() => show(el), performance.now() < warmUntil || cur ? 0 : 520);
    });
    document.addEventListener("pointerout", e => { if (e.pointerType !== "mouse") return; const el = owner(e); if (el && !el.contains(e.relatedTarget)) { clearTimeout(showT); if (el === cur) hide(); } });
    document.addEventListener("pointerdown", e => { if (e.pointerType === "mouse") hide(); }, true);
    document.addEventListener("pointerup", e => {   // a tap: the explanation follows the change
      if (e.pointerType !== "touch" && e.pointerType !== "pen") return;
      const el = owner(e); if (!el) return hide();
      clearTimeout(showT); showT = setTimeout(() => show(el, { ms: 3200 }), 260);
    });
    document.addEventListener("focusin", e => { const el = owner(e); if (el && el.matches(":focus-visible")) show(el); });
    document.addEventListener("focusout", e => { if (owner(e) === cur) hide(); });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && cur) hide(); }, true);
    addEventListener("scroll", hide, true); addEventListener("resize", hide);
    return { describe, hide };
  }

  /* ---------------- a cue: a ring of light round the place a step happened ---------------- */
  function cue(el, { inset = false } = {}) {
    if (!el || !el.isConnected) return;
    const ring = document.createElement("div");
    ring.className = "gd-cue" + (inset ? " inset" : ""); ring.setAttribute("aria-hidden", "true");
    const r = el.getBoundingClientRect(), pad = inset ? -4 : 5;
    Object.assign(ring.style, { left: r.left - pad + "px", top: r.top - pad + "px", width: r.width + pad * 2 + "px", height: r.height + pad * 2 + "px" });
    const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 10;
    ring.style.borderRadius = radius + (inset ? 0 : pad) + "px";
    document.body.append(ring);
    setTimeout(() => ring.remove(), reduced() ? 1600 : 2300);
  }

  function mount(api) {
    let p = load();
    if (api.fsId && !p.firstFs) { p = { ...p, firstFs: api.fsId }; save(p); }
    const tips = makeTips();
    const listeners = new Set();
    const set = next => { if (next === p) return; const was = p; p = next; save(p); paint(was); for (const fn of listeners) fn(p, was); };
    const phone = () => !!(api.phone && api.phone());

    /* ---- the welcome card ---- */
    const welcome = document.createElement("div");
    welcome.className = "gd-welcome"; welcome.hidden = true;
    welcome.innerHTML = `<div class="gd-scrim" data-close></div>
      <section class="gd-card glass" role="dialog" aria-modal="true" aria-labelledby="gd-w-h" aria-describedby="gd-w-p">
        <button class="gd-x" type="button" data-close aria-label="Close">${ICON_X}</button>
        <img class="gd-icon" src="assets-desktop/app-icon.png" alt="" width="64" height="64">
        <h2 id="gd-w-h">Tauri Explorer</h2>
        <p id="gd-w-p" class="gd-what">A file explorer you drive from the keyboard and arrange the way you like.</p>
        <p class="gd-live"><i class="led on" aria-hidden="true"></i><span>The window on this desktop is the real app, running live in your browser on sample files. Nothing here touches your computer.</span></p>
        <div class="gd-acts">
          <button class="btn primary" type="button" id="gd-tour">Show me around</button>
          <a class="btn gd-dl" id="gd-dl" href="${esc(api.download.href)}">${ICON_DL}<span>${esc(api.download.label)}</span></a>
        </div>
      </section>`;
    document.body.append(welcome);
    let welcomeFrom = null;
    function openWelcome() {
      if (!welcome.hidden || phone()) return;
      welcomeFrom = document.activeElement;
      welcome.hidden = false;
      for (const el of api.inert()) el.inert = true;
      document.body.classList.add("gd-welcoming");
      api.onQuiet?.();
      requestAnimationFrame(() => welcome.querySelector("#gd-tour").focus({ focusVisible: false }));
    }
    function closeWelcome({ tour = false } = {}) {
      if (welcome.hidden) return;
      welcome.hidden = true;
      for (const el of api.inert()) el.inert = false;
      document.body.classList.remove("gd-welcoming");
      set({ ...p, welcomed: true, ...(tour ? { open: true, dismissed: false } : {}) });
      if (tour) requestAnimationFrame(() => (card.querySelector(".gd-row:not(.done) .gd-go") || card.querySelector(".gd-fold")).focus());
      else if (welcomeFrom && welcomeFrom.isConnected && welcomeFrom !== document.body) welcomeFrom.focus();
      else api.focusApp?.();
    }
    welcome.addEventListener("click", e => { if (e.target.closest("[data-close]")) closeWelcome(); });
    welcome.querySelector("#gd-tour").addEventListener("click", () => closeWelcome({ tour: true }));
    welcome.querySelector("#gd-dl").addEventListener("click", () => { set({ ...p, welcomed: true }); });
    welcome.addEventListener("keydown", e => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeWelcome(); return; }
      if (e.key === "Tab") {
        const f = [...welcome.querySelectorAll("button, a[href]")], i = f.indexOf(document.activeElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); f.at(-1).focus(); }
        else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
      }
    });

    /* ---- the checklist: a pill in the desktop's lower band, unfolding into a card above it ---- */
    const box = document.createElement("aside");
    box.className = "gd-try"; box.id = "gd-try"; box.setAttribute("aria-label", "Try this");
    const STEPS = C.STEPS.filter(s => s.core);
    box.innerHTML = `<section class="gd-list glass" id="gd-list" hidden>
        <header class="gd-head"><h2 id="gd-h">Try this</h2><span class="gd-count" id="gd-count"></span>
          <button class="gd-fold" type="button" aria-expanded="true" aria-controls="gd-list" aria-label="Fold the list">${ICON_CHEV}</button></header>
        <ol class="gd-rows" aria-labelledby="gd-h">${STEPS.map(s => `<li class="gd-row" data-step="${s.id}">
          <span class="gd-mark" aria-hidden="true">${ICON_TICK}</span>
          <span class="gd-t"><b>${esc(s.title)}</b><span class="sr gd-state"></span><span class="gd-keys"></span></span>
          <span class="gd-l">${esc(s.line)}</span>
          <span class="gd-did" aria-live="polite"></span>
          <button class="gd-go" type="button" aria-label="Show me: ${esc(s.title.toLowerCase())}">Show me</button>
        </li>`).join("")}</ol>
        <div class="gd-end" id="gd-end" hidden>
          <p><b>That is the tour.</b> Everything you just did works the same in the app on your own computer, with your own files.</p>
          <div class="gd-end-acts"><a class="btn primary gd-dl" href="${esc(api.download.href)}">${ICON_DL}<span>${esc(api.download.label)}</span></a><button class="btn ghost" type="button" id="gd-away">Put this away</button></div>
        </div>
      </section>
      <button class="gd-pill glass" id="gd-pill" type="button" aria-expanded="false" aria-controls="gd-list">
        <span class="gd-leds" aria-hidden="true">${STEPS.map(s => `<i class="led" data-led="${s.id}"></i>`).join("")}</span>
        <span class="gd-pt">Try this</span><span class="gd-pn" id="gd-pn"></span></button>`;
    document.body.append(box);
    const card = box.querySelector("#gd-list"), pill = box.querySelector("#gd-pill");
    function setOpen(open, { focus = false } = {}) {
      set({ ...p, open, dismissed: false });
      if (focus) (open ? card.querySelector(".gd-fold") : pill).focus({ preventScroll: true });
    }
    pill.addEventListener("click", () => setOpen(!p.open, { focus: !p.open }));
    box.querySelector(".gd-fold").addEventListener("click", () => setOpen(false, { focus: true }));
    box.querySelector("#gd-away").addEventListener("click", () => { set({ ...p, open: false, dismissed: true }); api.focusApp?.(); });
    card.addEventListener("keydown", e => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false, { focus: true }); } });
    card.addEventListener("click", async e => {
      const go = e.target.closest(".gd-go"); if (!go) return;
      const row = go.closest(".gd-row"), id = row.dataset.step, s = C.byId(id);
      go.disabled = true;
      let res = null;
      try { res = await api.doStep(id); } finally { go.disabled = false; }
      if (!res) return;
      if (res.target) cue(res.target, { inset: !!res.inset });
      const did = row.querySelector(".gd-did");
      did.textContent = (s.did || "").replace("{name}", res.name || "it");
      row.classList.add("told");
      clearTimeout(row._t); row._t = setTimeout(() => row.classList.remove("told"), 9000);
    });

    let placedFor = "";
    function placeBox() {   // after the machine control in the desktop's lower band, never over the dock
      const drive = document.getElementById("drive"), dock = document.getElementById("dock");
      const d = drive && !drive.hidden ? drive.getBoundingClientRect() : null;
      const left = d && d.width ? d.right + 12 : 24;
      const k = `${left}|${innerWidth}|${innerHeight}`;
      if (k === placedFor) return; placedFor = k;
      box.style.setProperty("--gd-left", left + "px");
      const dk = dock && dock.getBoundingClientRect();
      box.classList.toggle("tight", !!(dk && dk.width && left + 210 > dk.left - 10));
    }
    addEventListener("resize", () => { placedFor = ""; placeBox(); });

    function paint(was) {
      const n = C.coreCount(p), all = C.allCore(p);
      for (const s of STEPS) {
        const row = card.querySelector(`[data-step="${s.id}"]`), done = C.isDone(p, s.id);
        row.classList.toggle("done", done);
        row.querySelector(".gd-state").textContent = done ? ", done" : ", not yet";
        row.querySelector(".gd-keys").innerHTML = s.keys ? api.keyHTML(s.keys) : "";
        box.querySelector(`[data-led="${s.id}"]`).classList.toggle("on", done);
        if (was && done && !C.isDone(was, s.id)) { row.classList.remove("ticked"); void row.offsetWidth; row.classList.add("ticked"); pill.classList.remove("ticked"); void pill.offsetWidth; pill.classList.add("ticked"); }
      }
      const next = C.nextCore(p);
      for (const row of card.querySelectorAll(".gd-row")) row.classList.toggle("cur", row.dataset.step === next);
      box.querySelector("#gd-count").textContent = `${n} of ${STEPS.length}`;
      box.querySelector("#gd-pn").textContent = all ? "Done" : `${n} of ${STEPS.length}`;
      box.querySelector("#gd-end").hidden = !all;
      box.classList.toggle("all", all);
      if (was && all && !C.allCore(was)) { box.classList.remove("payoff"); void box.offsetWidth; box.classList.add("payoff"); if (!p.open) set({ ...p, open: true }); }
      const open = p.open && !p.dismissed;
      card.hidden = !open;
      pill.setAttribute("aria-expanded", String(open));
      box.querySelector(".gd-fold").setAttribute("aria-expanded", String(open));
      sync();
    }
    // The story has the floor (a file open, the picker, the finale), or the phone layout: the checklist steps aside.
    function sync() {
      const off = phone() || p.dismissed || api.busy();
      box.hidden = off;
      if (!off) placeBox();
    }

    const guide = {
      get progress() { return p; },
      observe(e) { const next = C.observe(p, e); if (next !== p) set(next); },
      welcome() {
        if (phone()) { api.onPhoneWelcome?.(); return; }
        if (p.dismissed) set({ ...p, dismissed: false });
        openWelcome();
      },
      quiet: () => !welcome.hidden || (!box.hidden && !card.hidden) || !!api.phoneTourOn?.(),
      tips: root => tips.describe(root),
      hideTip: () => tips.hide(),
      cue,
      sync,
      repaint: () => paint(null),
      onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      markWelcomed() { if (!p.welcomed) set({ ...p, welcomed: true }); },
      start() {
        paint(null);
        if (!phone() && api.allowWelcome && C.shouldWelcome(p, {})) setTimeout(() => { if (!api.busy()) openWelcome(); }, reduced() ? 0 : 450);
      },
    };
    return guide;
  }

  window.TXGuide = { mount, cue };
})();
