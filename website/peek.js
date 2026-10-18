/* Folder peek — expand a folder in place, without navigating.
   Details: a tree. List: column-major with scrollable cards. Tiles: a panel
   in a band beside its row. Loaded before app.js; everything here reads
   app.js globals (FS, cwd, sortChildren, …) only when called, never at load. */

"use strict";

const PEEK_ROW = 30;      // list row height, px
const PEEK_MORE = 22;     // list card "+N more" footer, px
const PEEK_TAB_GAP = 10;  // tiles grid gap, which the panel's negative margin closes

function peekRead(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch { return fallback; }
}
function peekWrite(key, on) {
  try { localStorage.setItem(key, on ? "1" : "0"); } catch { /* session only */ }
}

const peek = {
  on: peekRead("folderPeek", true),          // setting: folderPeek
  carets: peekRead("folderPeekCarets", true), // setting: folderPeekCarets
  open: new Set(),         // full paths ("docs/guides") of open peeks; survives views + navigation
  side: new Map(),         // tiles panel placement chosen when it opened
  cardScroll: new Map(),   // list card scrollTop, so re-renders keep your place
  cursor: null,            // last cursor row (relative path), kept after Esc clears the selection
  reveal: null,            // panel to scroll into view after the next render
};

const peekReduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const peekKey = (path) => path.join("/");
const peekIsOpen = (path) => peek.on && peek.open.has(peekKey(path));
const peekActive = (mode) => peek.on && mode !== "columns";

const PEEK_CHEVRON = '<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 2.5 3.5 3.5L4 9.5"/></svg>';

/** Name of a row relative to the pane's folder, which is what data-name carries. */
const peekRel = (path) => path.slice(cwd.length).join("/");

/* ── Tree helpers ───────────────────────────────────────── */

/** Flatten open folders into rows, children following the current sort. */
function peekRows(nodes, parentPath, depth, out) {
  for (const node of nodes) {
    const path = [...parentPath, node.name];
    out.push({ node, path, depth });
    if (node.kind === "dir" && peekIsOpen(path)) {
      const kids = sortChildren(node.children || []);
      if (kids.length) peekRows(kids, path, depth + 1, out);
      else out.push({ empty: true, depth: depth + 1 });
    }
  }
  return out;
}

function peekCaret(node, path) {
  if (!peek.carets) return null;
  const caret = document.createElement("span");
  if (node.kind !== "dir") { caret.className = "pcaret spacer"; return caret; }
  const open = peekIsOpen(path);
  caret.className = "pcaret" + (open ? " open" : "");
  caret.setAttribute("role", "button");
  caret.setAttribute("aria-expanded", String(open));
  caret.setAttribute("aria-label", `${open ? "Collapse" : "Expand"} ${node.name}`);
  caret.innerHTML = PEEK_CHEVRON;
  caret.onclick = (e) => { e.stopPropagation(); peekToggle(path); };
  caret.onmousedown = (e) => e.stopPropagation();
  caret.ondblclick = (e) => e.stopPropagation();
  return caret;
}

/** One click/dblclick contract for every view. With carets off, a plain click
    on a folder toggles it (as in VS Code) and double-click opens it. */
function peekWire(el, node, path, ctx) {
  const rel = peekRel(path);
  const parentBase = path.slice(0, -1);
  const folderToggles = node.kind === "dir" && !peek.carets;
  el.onclick = () => {
    if (folderToggles) {
      selectedName = rel;
      peek.cursor = rel;
      peekToggle(path);
    } else ctx.open(node, rel);
  };
  if (folderToggles) el.ondblclick = () => ctx.open(node, rel);
  el.oncontextmenu = (e) => fileCtx(e, node, 0, parentBase, rel);
}

/* ── Details: a tree ────────────────────────────────────── */

function peekDetailsRow(entry, ctx) {
  const { node, path, depth } = entry;
  const rel = peekRel(path);
  if (entry.empty) {
    const row = document.createElement("div");
    row.className = "row peek-empty";
    row.style.setProperty("--depth", depth);
    row.innerHTML = `<span class="name"><span class="pguides"></span><span class="fname">Empty folder</span></span><span></span><span></span>`;
    return row;
  }
  const editing = depth === 0 && editingName === node.name;
  const row = document.createElement(editing ? "div" : "button");
  const open = node.kind === "dir" && peekIsOpen(path);
  row.className = "row peeked" + (open ? " peek-open" : "") + (ctx.selName === rel ? " selected" : "");
  row.dataset.name = rel;
  row.style.setProperty("--depth", depth);
  const badge = node.badge ? `<span class="try">${node.badge}</span>` : "";
  row.innerHTML = `
    <span class="name"><span class="pguides"></span><span class="ico">${iconFor(node)}</span><span class="fname">${node.name}</span>${badge}</span>
    <span class="meta kind">${node.kind === "dir" ? "Folder" : node.kind === "img" ? "PNG image" : "Markdown"}</span>
    <span class="meta">${node.kind === "dir" ? `${(node.children || []).length} items` : node.size || ""}</span>`;
  const caret = peekCaret(node, path);
  if (caret) row.querySelector(".name").insertBefore(caret, row.querySelector(".ico"));
  if (editing) mountRename(row, ".fname", node, 0);
  else peekWire(row, node, path, ctx);
  return row;
}

function peekDetails(fl, base, nodes, ctx) {
  for (const entry of peekRows(nodes, base, 0, [])) fl.appendChild(peekDetailsRow(entry, ctx));
}

/* ── List: column-major columns with scrollable cards ───── */

function peekListRow(entry, ctx, inCard) {
  const { node, path, depth } = entry;
  if (entry.empty) {
    const row = document.createElement("div");
    row.className = "lrow peek-empty";
    row.style.setProperty("--depth", depth);
    row.innerHTML = `<span class="pguides"></span><span class="fname">Empty folder</span>`;
    return row;
  }
  const rel = peekRel(path);
  const editing = depth === 0 && !inCard && editingName === node.name;
  const row = document.createElement(editing ? "div" : "button");
  const open = node.kind === "dir" && peekIsOpen(path);
  row.className = "lrow peeked" + (open ? " peek-open" : "") + (ctx.selName === rel ? " selected" : "");
  row.dataset.name = rel;
  row.style.setProperty("--depth", depth);
  row.innerHTML = `<span class="pguides"></span><span class="ico">${iconFor(node)}</span><span class="fname">${node.name}</span>`;
  const caret = peekCaret(node, path);
  if (caret) row.insertBefore(caret, row.querySelector(".ico"));
  if (editing) mountRename(row, ".fname", node, 0);
  else peekWire(row, node, path, ctx);
  return row;
}

/** A card is an open folder: fixed header, a scrollable body of its rows, "+N more". */
function peekCard(entry, ctx, capRows) {
  const { node, path } = entry;
  const key = peekKey(path);
  const rows = peekRows(sortChildren(node.children || []), path, 0, []);
  if (!rows.length) rows.push({ empty: true, depth: 0 });
  const visible = Math.min(rows.length, capRows);
  const more = rows.length > visible;

  const card = document.createElement("div");
  card.className = "pcard";
  card.dataset.peek = key;
  card.style.height = `${PEEK_ROW * (1 + visible) + (more ? PEEK_MORE : 0) + 2}px`; // +2: the card's 1px border

  const head = peekListRow({ node, path, depth: 0 }, ctx, false);
  head.classList.add("pcard-head");
  card.appendChild(head);

  const body = document.createElement("div");
  body.className = "pcard-body";
  body.style.height = `${PEEK_ROW * visible}px`;
  for (const r of rows) body.appendChild(peekListRow({ ...r, depth: r.depth }, ctx, true));
  card.appendChild(body);

  const foot = document.createElement("div");
  foot.className = "pcard-more";
  card.appendChild(foot);

  const update = () => {
    const hiddenBelow = Math.max(0, Math.round((body.scrollHeight - body.scrollTop - body.clientHeight) / PEEK_ROW));
    body.classList.toggle("fade-top", body.scrollTop > 2);
    body.classList.toggle("fade-bottom", hiddenBelow > 0);
    foot.textContent = hiddenBelow > 0 ? `+${hiddenBelow} more` : "";
  };
  body.addEventListener("scroll", () => { peek.cardScroll.set(key, body.scrollTop); update(); }, { passive: true });
  card._after = () => { body.scrollTop = peek.cardScroll.get(key) || 0; update(); };
  return card;
}

function peekList(fl, base, nodes, ctx) {
  fl.classList.add("peek-list");
  // vertical room per column: the box minus its padding and a horizontal scrollbar
  const room = Math.max(PEEK_ROW * 4, (fl.offsetHeight || 420) - 22 - 14);
  const rowsPerCol = Math.floor(room / PEEK_ROW);
  const capRows = Math.max(2, Math.min(6, rowsPerCol - 2));

  let col = null, y = 0;
  const nextColumn = () => {
    col = document.createElement("div");
    col.className = "pcol";
    fl.appendChild(col);
    y = 0;
  };
  nextColumn();
  const cards = [];
  for (const node of nodes) {
    const path = [...base, node.name];
    const open = node.kind === "dir" && peekIsOpen(path);
    const el = open ? peekCard({ node, path }, ctx, capRows) : peekListRow({ node, path, depth: 0 }, ctx, false);
    const h = open ? parseFloat(el.style.height) : PEEK_ROW;
    // a card that doesn't fit the rest of this column starts the next one
    if (y > 0 && y + h > room) nextColumn();
    col.appendChild(el);
    y += h;
    if (open) cards.push(el);
  }
  cards.forEach((c) => c._after());
}

/* ── Tiles: a panel in a band beside its row ────────────── */

function peekTile(node, path, ctx, mini) {
  const rel = peekRel(path);
  const editing = !mini && editingName === node.name;
  const tile = document.createElement(editing ? "div" : "button");
  const open = node.kind === "dir" && peekIsOpen(path);
  tile.className = "tile" + (mini ? " mini" : "") + (open ? " peek-open" : "") + (ctx.selName === rel ? " selected" : "");
  tile.dataset.name = rel;
  tile.innerHTML = `
    ${node.thumb
      ? `<img class="thumb" src="${node.thumb}" alt="${node.name}" loading="lazy" decoding="async" />`
      : `<span class="ticon">${iconFor(node)}</span>`}
    <span class="tname">${node.name}</span>`;
  const caret = peekCaret(node, path);
  if (caret && node.kind === "dir") tile.appendChild(caret);
  if (editing) mountRename(tile, ".tname", node, 0);
  else peekWire(tile, node, path, ctx);
  return tile;
}

const peekCols = (grid) => Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(" ").length);

/** Build the panel for an open folder: a tab under its tile, a mini grid of children. */
function peekPanel(node, path, ctx) {
  const key = peekKey(path);
  const panel = document.createElement("div");
  panel.className = "ppanel";
  panel.dataset.peek = key;
  const gap = document.createElement("span");
  gap.className = "ptab";
  panel.appendChild(gap);
  const grid = document.createElement("div");
  grid.className = "pgrid";
  const kids = sortChildren(node.children || []);
  if (!kids.length) grid.innerHTML = `<div class="pempty">Empty folder</div>`;
  const items = kids.map((k) => {
    const kp = [...path, k.name];
    const el = peekTile(k, kp, ctx, true);
    grid.appendChild(el);
    return { el, node: k, path: kp };
  });
  panel.appendChild(grid);
  return { panel, grid, items };
}

/** Place a panel after (or before) the row holding its tile, and cut the tab out of its outline. */
function peekPlacePanels(grid, items, ctx, depth) {
  const cols = peekCols(grid);
  const rows = new Map();
  items.forEach((it, i) => {
    if (it.node.kind !== "dir" || !peekIsOpen(it.path)) return;
    const r = Math.floor(i / cols);
    if (!rows.has(r)) rows.set(r, []);
    rows.get(r).push(it);
  });
  for (const r of [...rows.keys()].sort((a, b) => a - b)) {
    const rowItems = items.slice(r * cols, (r + 1) * cols);
    const first = rowItems[0].el, last = rowItems[rowItems.length - 1].el;
    let anchor = last;
    for (const it of rows.get(r)) {
      const key = peekKey(it.path);
      const { panel, grid: inner, items: kids } = peekPanel(it.node, it.path, ctx);
      anchor.after(panel);
      peekPlacePanels(inner, kids, ctx, depth + 1);

      let side = peek.side.get(key);
      if (!side) {
        side = "below";
        if (depth === 0) {
          const h = panel.offsetHeight + PEEK_TAB_GAP;
          const top = grid.scrollTop, bottom = top + grid.clientHeight;
          const rowTop = first.offsetTop, rowBottom = last.offsetTop + last.offsetHeight;
          if (rowBottom + h > bottom && rowTop - h >= top) side = "above";
        }
        peek.side.set(key, side);
      }
      panel.dataset.side = side;
      it.el.classList.add(side === "above" ? "peek-above" : "peek-below");
      if (side === "above") { first.before(panel); } else anchor = panel;

      const tile = it.el;
      panel.style.setProperty("--tab-x", `${tile.offsetLeft - panel.offsetLeft}px`);
      panel.style.setProperty("--tab-w", `${tile.offsetWidth}px`);
    }
  }
}

function peekTiles(fl, base, nodes, ctx) {
  const items = nodes.map((node) => {
    const path = [...base, node.name];
    const el = peekTile(node, path, ctx, false);
    fl.appendChild(el);
    return { el, node, path };
  });
  peekPlacePanels(fl, items, ctx, 0);
}

/* ── Entry point from buildList ─────────────────────────── */

function peekRender(fl, mode, base, nodes, ctx) {
  fl.classList.toggle("peek-list", false);
  if (mode === "list") peekList(fl, base, nodes, ctx);
  else if (mode === "tiles") peekTiles(fl, base, nodes, ctx);
  else peekDetails(fl, base, nodes, ctx);
  if (!nodes.length) fl.insertAdjacentHTML("beforeend", `<div class="empty-dir">Empty folder</div>`);
}

/** Re-render just the file list, keeping scroll, with one coherent motion. */
function peekRefresh(animate) {
  const fl = document.getElementById("filelist");
  const before = animate ? peekSnapshot(fl) : null;
  const top = fl.scrollTop, left = fl.scrollLeft;
  buildList(fl, cwd, selectedName, 0);
  fl.scrollTop = top;
  fl.scrollLeft = left;
  if (peek.reveal) {
    const el = fl.querySelector(`[data-peek="${CSS.escape(peek.reveal)}"]`);
    peek.reveal = null;
    if (el) el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: peekReduced() ? "auto" : "smooth" });
  }
  if (before) peekPlay(fl, before);
  if (typeof syncTab === "function") syncTab();
}

/* ── Motion ─────────────────────────────────────────────── */

const peekId = (el) => (el.dataset.name !== undefined ? "n:" + el.dataset.name : "p:" + el.dataset.peek);
const peekNested = (el) => !!el.parentElement.closest(".pcard, .ppanel");

function peekSnapshot(fl) {
  const m = new Map();
  fl.querySelectorAll("[data-name], [data-peek]").forEach((el) => {
    if (!peekNested(el)) m.set(peekId(el), el.getBoundingClientRect());
  });
  return m;
}

function peekPlay(fl, before) {
  if (peekReduced()) return;
  const view = fl.getBoundingClientRect();
  const near = (r) => r.bottom > view.top - 200 && r.top < view.bottom + 200 && r.right > view.left - 200 && r.left < view.right + 200;
  const ease = "cubic-bezier(0.2, 0, 0, 1)";
  let fresh = 0;
  fl.querySelectorAll("[data-name], [data-peek]").forEach((el) => {
    if (peekNested(el)) return;
    const was = before.get(peekId(el));
    const now = el.getBoundingClientRect();
    if (was) {
      const dx = was.left - now.left, dy = was.top - now.top;
      if ((Math.abs(dx) > 1 || Math.abs(dy) > 1) && (near(was) || near(now)))
        el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 220, easing: ease });
    } else if (near(now)) {
      const grow = el.matches(".pcard, .ppanel");
      el.animate(
        [{ opacity: 0, transform: `translateY(${grow ? -8 : -4}px)` }, { opacity: 1, transform: "none" }],
        { duration: 200, delay: grow ? 0 : Math.min(fresh++, 8) * 14, easing: ease, fill: "backwards" });
    }
  });
}

/* ── Commands ───────────────────────────────────────────── */

function peekToggle(path, force) {
  const key = peekKey(path);
  const open = force === undefined ? !peek.open.has(key) : force;
  if (open === peek.open.has(key)) return;
  if (open) { peek.open.add(key); peek.reveal = key; }
  else { peek.open.delete(key); peek.side.delete(key); }
  peekRefresh(true);
}

function peekViewOk() {
  return peek.on && viewFor(cwd, 0) !== "columns";
}

/** Palette: peek into the selected folder, or the first folder here. */
function peekIntoFolder() {
  if (!peek.on) { toast("Folder peek is off. Run <em>Toggle Folder Peek</em> to bring it back."); return; }
  if (viewFor(cwd, 0) === "columns") { toast("Peek works in Details, List and Tiles. Columns already shows every level."); return; }
  let path = null;
  if (selectedName) {
    const parts = selectedName.split("/");
    const node = findNode([...cwd, ...parts]);
    if (node && node.kind === "dir") path = [...cwd, ...parts];
  }
  if (!path) {
    const first = sortChildren(nodeAt(cwd).children || []).find((c) => c.kind === "dir");
    if (!first) { toast("No folders in here to peek into."); return; }
    path = [...cwd, first.name];
  }
  selectedName = peekRel(path);
  peek.cursor = selectedName;
  peekToggle(path, true);
}

/** Toast action: land somewhere with a folder worth peeking into, already open. */
function peekDemo() {
  if (!peek.on) peekSetting("on");
  if (viewFor(cwd, 0) === "columns") setView("details");
  if (cwd.length) navigate([]);
  peek.open.add("docs");
  peek.open.add("docs/guides");
  selectedName = null;
  peek.cursor = "docs/guides";
  peekRefresh(true);
  const row = $("filelist").querySelector('[data-name="docs"]');
  if (row) row.scrollIntoView({ block: "nearest" });
}

function peekCollapseAll() {
  if (!peek.open.size) { toast("No peeks are open."); return; }
  peek.open.clear();
  peek.side.clear();
  peek.cardScroll.clear();
  if (peekViewOk()) peekRefresh(true);
}

function peekSetting(which) {
  if (which === "on") {
    peek.on = !peek.on;
    peekWrite("folderPeek", peek.on);
    // a nested selection can't exist once the tree is gone
    if (!peek.on && selectedName && selectedName.includes("/")) selectedName = null;
    toast(peek.on
      ? "Folder peek on: carets expand folders in place."
      : "Folder peek off: the classic views, including the row-major List.");
  } else {
    peek.carets = !peek.carets;
    peekWrite("folderPeekCarets", peek.carets);
    toast(peek.carets
      ? "Carets on: click ▸ to peek, click the name to open."
      : "Carets off: a single click on a folder toggles its peek. Double-click opens it.");
  }
  renderPanes();
}

/** Esc: clear the selection first, then close the peek holding the cursor.
    Returns true when it consumed the key. */
function peekEscape() {
  if (!peekViewOk()) return false;
  if (selectedName) {
    peek.cursor = selectedName;
    selectedName = null;
    if (!$("preview").hidden) setPreview(false);
    renderPanes();
    syncTab();
    return true;
  }
  if (!peek.cursor) return false;
  const parts = peek.cursor.split("/");
  const own = [...cwd, ...parts];
  // the peek holding the cursor: its parent folder, or itself when it is an open top-level row
  const holder = parts.length > 1 ? own.slice(0, -1) : peekIsOpen(own) ? own : null;
  if (!holder) { peek.cursor = null; return false; }
  peek.cursor = peekRel(holder);
  peekToggle(holder, false);
  return true;
}

/** Details tree keys: Right opens a folder, Left closes it or climbs to its parent. */
function peekTreeKey(e) {
  if (!peekViewOk() || viewFor(cwd, 0) !== "details" || !selectedName) return false;
  if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return false;
  const parts = selectedName.split("/");
  const path = [...cwd, ...parts];
  const node = findNode(path);
  if (!node) return false;
  const isOpen = node.kind === "dir" && peekIsOpen(path);
  if (e.key === "ArrowRight" && node.kind === "dir" && !isOpen) {
    e.preventDefault();
    peekToggle(path, true);
    return true;
  }
  if (e.key === "ArrowLeft") {
    if (isOpen) { e.preventDefault(); peekToggle(path, false); return true; }
    if (parts.length > 1) {
      e.preventDefault();
      selectedName = parts.slice(0, -1).join("/");
      peek.cursor = selectedName;
      const fl = $("filelist");
      fl.querySelectorAll("[data-name]").forEach((r) => r.classList.toggle("selected", r.dataset.name === selectedName));
      const row = [...fl.querySelectorAll("[data-name]")].find((r) => r.dataset.name === selectedName);
      if (row) row.scrollIntoView({ block: "nearest" });
      return true;
    }
  }
  return false;
}

/* ── Layout reacts to the box, not just the window ──────── */

(function peekWatch() {
  const fl = document.getElementById("filelist");
  if (!fl) return;
  // vertical wheel scrolls the List sideways, unless a card can still scroll that way
  fl.addEventListener("wheel", (e) => {
    if (!fl.classList.contains("peek-list") || e.ctrlKey) return;
    const body = e.target.closest && e.target.closest(".pcard-body");
    if (body) {
      const room = e.deltaY < 0 ? body.scrollTop > 0 : body.scrollTop + body.clientHeight < body.scrollHeight - 1;
      if (room) return;
    }
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault();
      fl.scrollLeft += e.deltaY;
    }
  }, { passive: false });

  let last = "", raf = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const size = `${fl.offsetWidth}x${fl.offsetHeight}`;
      const mode = typeof viewFor === "function" ? viewFor(cwd, 0) : null;
      const needs = peek.on && (mode === "list" || (mode === "tiles" && peek.open.size));
      if (size === last || !needs) { last = size; return; }
      last = size;
      if (editingName) return;
      peekRefresh(false);
    });
  }).observe(fl);
})();
