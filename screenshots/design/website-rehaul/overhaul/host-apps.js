"use strict";
/* =====================================================================================================
   HOST APPS: what the operating system would open a file with. The explorer hands a file over
   (the stage's "open-external" event); one of these small programs shows it above the stage.
   They belong to the page, not to the explorer, so they look like other applications.
   HostApps.open(file, { origin, locate, onClose, inert })
     file    { path, name, kind, text, src, poster, size, date, px, duration }   (the event payload)
     origin  { x, y, w, h } in viewport pixels, or null: the window grows out of it and returns to it
     locate  path -> origin|null, asked again on close (the file may have moved on screen)
     onClose ()   -> called once the window is gone (the page returns focus to the explorer)
     inert   [elements] made inert while a window is up
   ===================================================================================================== */
(function () {
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const reduce = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const small = () => matchMedia("(max-width: 600px)").matches;
  const extOf = n => (String(n).match(/\.([^.]+)$/)?.[1] || "").toLowerCase();
  const AUDIO_RE = /\.(wav|flac|mp3|ogg|m4a|aiff?)$/i;

  /* ---------------- which program opens what: first match wins ---------------- */
  const OPENS_WITH = [
    ["lock",     f => /\.lock$/i.test(f.name) && f.text != null],   // the escape room's locks, ahead of any kind
    ["video",    f => f.kind === "video"],
    ["image",    f => !!f.src],
    ["markdown", f => f.text != null && /\.(md|markdown)$/i.test(f.name)],
    ["table",    f => f.text != null && /\.(csv|tsv)$/i.test(f.name)],
    ["audio",    f => f.kind === "audio" || AUDIO_RE.test(f.name)],
    ["text",     f => f.text != null],
    ["document", () => true],
  ];
  const appFor = f => OPENS_WITH.find(([, test]) => test(f))[0];

  /* ---------------- shared bits ---------------- */
  const fmtDate = d => {
    const t = Date.parse(d); if (!d || isNaN(t)) return d || "";
    return new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  };
  const fmtWhen = d => {
    const t = Date.parse(d); if (!d || isNaN(t)) return d || "";
    const x = new Date(t), hasTime = /T\d\d:\d\d/.test(d);
    return x.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) + (hasTime ? ", " + x.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "");
  };
  const ICON = {
    markdown: `<svg viewBox="0 0 20 20"><rect x="1" y="1" width="18" height="18" rx="5" fill="#2c4f7c"/><path d="M5.5 6.5h9M5.5 9.5h9M5.5 12.5h6" stroke="#f5f1e6" stroke-width="1.6" stroke-linecap="round"/></svg>`,
    text: `<svg viewBox="0 0 20 20"><rect x="1" y="1" width="18" height="18" rx="5" fill="#2a2e37"/><path d="m5.5 7 3 3-3 3" fill="none" stroke="#8fd3b5" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M10.5 13.2h4" stroke="#d6dae2" stroke-width="1.7" stroke-linecap="round"/></svg>`,
    table: `<svg viewBox="0 0 20 20"><rect x="1" y="1" width="18" height="18" rx="5" fill="#13704f"/><path d="M4.8 7.6h10.4M4.8 10.8h10.4M4.8 14h10.4M8.6 4.8v10.6" stroke="#e9fbf2" stroke-width="1.3" stroke-linecap="round"/></svg>`,
    image: `<svg viewBox="0 0 20 20"><defs><linearGradient id="ha-gi" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f2b24a"/><stop offset="1" stop-color="#c2412d"/></linearGradient></defs><rect x="1" y="1" width="18" height="18" rx="5" fill="url(#ha-gi)"/><path d="m3.8 14.6 4-4.6 3 3.2 1.8-1.8 3.6 3.2" fill="none" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/><circle cx="13.2" cy="6.8" r="1.6" fill="#fff"/></svg>`,
    video: `<svg viewBox="0 0 20 20"><rect x="1" y="1" width="18" height="18" rx="5" fill="#111"/><rect x="1.6" y="1.6" width="16.8" height="16.8" rx="4.4" fill="none" stroke="#3a3a3a"/><path d="M8 6.2v7.6c0 .4.4.6.7.4l5.6-3.8a.5.5 0 0 0 0-.8L8.7 5.8c-.3-.2-.7 0-.7.4z" fill="#f4f4f4"/></svg>`,
    audio: `<svg viewBox="0 0 20 20"><defs><linearGradient id="ha-ga" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3b2d5c"/><stop offset="1" stop-color="#1b1726"/></linearGradient></defs><rect x="1" y="1" width="18" height="18" rx="5" fill="url(#ha-ga)"/><path d="M5 10v0M7.5 7.5v5M10 5v10M12.5 8v4M15 9.2v1.6" stroke="#f3b562" stroke-width="1.7" stroke-linecap="round"/></svg>`,
    lock: `<svg viewBox="0 0 20 20"><defs><linearGradient id="ha-gl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f3d27a"/><stop offset="1" stop-color="#b8862b"/></linearGradient></defs><rect x="1" y="1" width="18" height="18" rx="5" fill="#23262d"/><path d="M7 9V7.2a3 3 0 0 1 6 0V9" fill="none" stroke="#c9ccd3" stroke-width="1.6"/><rect x="5" y="9" width="10" height="7.5" rx="1.8" fill="url(#ha-gl)"/><circle cx="10" cy="12.3" r="1.1" fill="#5a4211"/></svg>`,
    document: `<svg viewBox="0 0 20 20"><rect x="1" y="1" width="18" height="18" rx="5" fill="#e9e6e1"/><path d="M6.5 3.8h5l3 3v9.4h-8z" fill="#fff" stroke="#8a8478" stroke-width="1.1" stroke-linejoin="round"/><path d="M8.3 10h4.4M8.3 12.3h4.4" stroke="#b4342a" stroke-width="1.2" stroke-linecap="round"/></svg>`,
  };
  const NAME = { lock: "Lock", markdown: "Markdown Viewer", text: "Text Editor", table: "Table", image: "Image Viewer", video: "Video Player", audio: "Audio Player", document: "Document Viewer" };

  /* ---------------- Markdown: escaped first, then a small block and inline grammar. No HTML passes through. ---------------- */
  function inline(s) {
    let h = esc(s);
    const codes = [];
    h = h.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
    h = h.replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/__([^_]+)__/g, "<strong>$1</strong>");
    h = h.replace(/(^|[^*\w])\*(?!\s)([^*]+?)\*(?!\w)/g, "$1<em>$2</em>").replace(/(^|[^\w])_(?!\s)([^_]+?)_(?!\w)/g, "$1<em>$2</em>");
    h = h.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    return h.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
  }
  function markdown(src) {
    const L = String(src).replace(/\r\n?/g, "\n").split("\n");
    let i = 0; const out = [], meta = [];
    if (L[0] === "---") { const end = L.indexOf("---", 1); if (end > 0) { for (const l of L.slice(1, end)) { const m = l.match(/^([\w -]+):\s*(.+)$/); if (m) meta.push([m[1], m[2]]); } i = end + 1; } }
    const isBlock = l => /^(#{1,6})\s|^```|^>\s?|^\s*([-*+]|\d+[.)])\s+|^(-{3,}|\*{3,}|_{3,})\s*$/.test(l) || /^\|.*\|\s*$/.test(l);
    while (i < L.length) {
      const l = L[i];
      if (!l.trim()) { i++; continue; }
      let m;
      if ((m = l.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/))) { const n = m[1].length; out.push(`<h${n}>${inline(m[2])}</h${n}>`); i++; continue; }
      if (/^```/.test(l)) { const body = []; i++; while (i < L.length && !/^```/.test(L[i])) body.push(L[i++]); i++; out.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`); continue; }
      if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) { out.push("<hr>"); i++; continue; }
      if (/^>\s?/.test(l)) { const q = []; while (i < L.length && /^>\s?/.test(L[i])) q.push(L[i++].replace(/^>\s?/, "")); out.push(`<blockquote>${markdown(q.join("\n")).html}</blockquote>`); continue; }
      if (/^\|.*\|\s*$/.test(l) && /^\|?\s*:?-{2,}/.test(L[i + 1] || "")) {
        const cells = r => r.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());
        const head = cells(l); i += 2; const rows = [];
        while (i < L.length && /^\|.*\|\s*$/.test(L[i])) rows.push(cells(L[i++]));
        out.push(`<div class="md-tw"><table><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
        continue;
      }
      if ((m = l.match(/^\s*([-*+]|\d+[.)])\s+/))) {
        const ordered = /\d/.test(m[1]), items = [];
        while (i < L.length && /^\s*([-*+]|\d+[.)])\s+/.test(L[i])) {
          let t = L[i++].replace(/^\s*([-*+]|\d+[.)])\s+/, "");
          while (i < L.length && /^\s{2,}\S/.test(L[i]) && !/^\s*([-*+]|\d+[.)])\s+/.test(L[i])) t += " " + L[i++].trim();
          const task = t.match(/^\[([ xX])\]\s+(.*)$/);
          items.push(task ? `<li class="task${task[1] !== " " ? " done" : ""}"><i aria-hidden="true"></i>${inline(task[2])}</li>` : `<li>${inline(t)}</li>`);
        }
        out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
        continue;
      }
      const p = [];
      while (i < L.length && L[i].trim() && (p.length === 0 || !isBlock(L[i]))) p.push(L[i++]);
      out.push(`<p>${p.map(inline).join("<br>")}</p>`);
    }
    return { html: out.join("\n"), meta };
  }

  /* ---------------- CSV: quoted fields, commas or tabs ---------------- */
  function csv(text, tab) {
    const rows = []; let row = [], f = "", q = false; const sep = tab ? "\t" : ",";
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; continue; }
      if (c === '"' && f === "") q = true;
      else if (c === sep) { row.push(f); f = ""; }
      else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(f); rows.push(row); row = []; f = ""; }
      else f += c;
    }
    if (f !== "" || row.length) { row.push(f); rows.push(row); }
    return rows.filter(r => r.some(c => c.trim() !== ""));
  }
  const NUM_RE = /^[-+]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?\s*%?$/;
  const asNum = s => { const t = String(s).trim(); return t && NUM_RE.test(t) && /\d/.test(t) ? parseFloat(t.replace(/,/g, "")) : NaN; };

  /* ---------------- syntax colour for the text editor: comments, strings, numbers, log levels ---------------- */
  const escT = s => String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  const KW = "def|return|import|from|for|in|if|else|elif|while|function|const|let|var|true|false|null|None|True|False|fn|pub|use|struct|impl|class|export|with|as|not|and|or";
  const GRAMMAR = {   // one pass per line: each capture group is a token class, everything between is plain text
    log: [/^(#.*)$|^(\d{4}-\d\d-\d\dT[\d:.]+Z?)|\b(ERROR|ERR|FAIL(?:ED)?|FATAL)\b|\b(WARN(?:ING)?)\b|\b([a-z_]+)(?==)/g, ["t-com", "t-time", "t-bad", "t-warn", "t-key"]],
    mail: [/^([A-Z][\w-]*)(?=:)/g, ["t-key"]],
    hash: [new RegExp(`(#.*$)|("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')|\\b(\\d+(?:\\.\\d+)?)\\b|\\b(${KW})\\b`, "g"), ["t-com", "t-str", "t-num", "t-kw"]],
    slash: [new RegExp(`(\\/\\/.*$)|("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')|\\b(\\d+(?:\\.\\d+)?)\\b|\\b(${KW})\\b`, "g"), ["t-com", "t-str", "t-num", "t-kw"]],
  };
  function tint(line, lang) {
    const g = GRAMMAR[lang === "py" || lang === "sh" || lang === "conf" ? "hash" : lang === "code" ? "slash" : lang];
    if (!g) return escT(line);
    const [re, cls] = g; re.lastIndex = 0;
    let out = "", at = 0, m;
    while ((m = re.exec(line))) {
      if (!m[0]) { re.lastIndex++; continue; }
      const k = m.slice(1).findIndex(x => x !== undefined);
      out += escT(line.slice(at, m.index)) + `<span class="${cls[k]}">${escT(m[0])}</span>`;
      at = m.index + m[0].length;
    }
    return out + escT(line.slice(at));
  }
  const LANG = { log: ["log", "Log"], txt: ["plain", "Plain text"], eml: ["mail", "Email"], json: ["code", "JSON"], py: ["py", "Python"], sh: ["sh", "Shell"], js: ["code", "JavaScript"], ts: ["code", "TypeScript"], rs: ["code", "Rust"], toml: ["conf", "TOML"], yaml: ["conf", "YAML"], yml: ["conf", "YAML"], ini: ["conf", "INI"], conf: ["conf", "Config"], csv: ["plain", "CSV"], md: ["plain", "Markdown"] };
  const langOf = name => LANG[extOf(name)] || (/^\./.test(name) ? ["conf", "Config"] : ["plain", "Plain text"]);

  /* ---------------- deterministic waveform from a name ---------------- */
  function seeded(str) { let h = 2166136261; for (const c of str) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return () => { h += 0x6D2B79F5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function waveform(name, n = 120) {
    const r = seeded(name), bars = []; let env = .4;
    for (let i = 0; i < n; i++) { env += (r() - .5) * .22; env = Math.min(.95, Math.max(.12, env)); const v = Math.min(1, env * (.55 + r() * .6)); bars.push(v); }
    for (let k = 0; k < 2; k++) for (let i = 1; i < n - 1; i++) bars[i] = (bars[i - 1] + bars[i] * 2 + bars[i + 1]) / 4;
    const w = 600, h = 120, bw = w / n;
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="ha-wv" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${w}" y2="0"><stop offset="0" stop-color="#f6c16b"/><stop offset=".55" stop-color="#f08a6c"/><stop offset="1" stop-color="#b479e0"/></linearGradient></defs>`
      + bars.map((v, i) => { const bh = Math.max(3, v * (h - 8)); return `<rect x="${(i * bw + bw * .18).toFixed(2)}" y="${((h - bh) / 2).toFixed(2)}" width="${(bw * .64).toFixed(2)}" height="${bh.toFixed(2)}" rx="${(bw * .32).toFixed(2)}"/>`; }).join("") + `</svg>`;
  }

  /* ================================ the programs ================================ */
  const APPS = {
    markdown: {
      size: [760, 860],
      render(f) {
        const { html, meta } = markdown(f.text || "");
        const words = (f.text || "").split(/\s+/).filter(Boolean).length, mins = Math.max(1, Math.round(words / 220));
        return {
          body: `<article class="md-page"><div class="md-meta">${esc(fmtDate(f.date))}${f.date ? `<span class="md-dot" aria-hidden="true"></span>` : ""}${mins} min read</div>`
            + (meta.length ? `<dl class="md-props">${meta.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${inline(v)}</dd>`).join("")}</dl>` : "")
            + `<div class="md-doc">${html}</div></article>`,
          foot: `<span>${words.toLocaleString("en")} words</span><span>${esc(f.size)}</span>`,
          scroller: ".ha-body",
        };
      },
    },
    text: {
      size: [900, 660],
      render(f, win) {
        const lines = String(f.text ?? "").replace(/\r\n?/g, "\n").split("\n");
        if (lines.length > 1 && lines.at(-1) === "") lines.pop();
        const [lang, langName] = langOf(f.name), CH = 150, digits = String(lines.length).length;
        let html = "";
        for (let s = 0; s < lines.length; s += CH) {
          const part = lines.slice(s, s + CH);
          html += `<div class="te-chunk" style="contain-intrinsic-size:auto ${part.length * 21}px">` + part.map((l, k) => `<div class="te-l"><i>${s + k + 1}</i><span>${tint(l, lang) || " "}</span></div>`).join("") + `</div>`;
        }
        return {
          tools: `<button type="button" class="ha-tool" data-wrap aria-pressed="false" title="Word wrap"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4h11M2.5 8h9a2 2 0 0 1 0 4H8.5m0 0 1.6-1.6M8.5 12l1.6 1.6M2.5 12h3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Wrap</span></button>`,
          body: `<div class="te-code" style="--gut:${digits + 2}ch">${html}</div>`,
          foot: `<span>${lines.length.toLocaleString("en")} lines</span><span>${esc(langName)}</span><span>UTF-8</span><span class="ro">Read-only</span>`,
          scroller: ".ha-body",
          mount() {
            const b = win.querySelector("[data-wrap]"), code = win.querySelector(".te-code");
            b.addEventListener("click", () => { const on = b.getAttribute("aria-pressed") !== "true"; b.setAttribute("aria-pressed", on); code.classList.toggle("wrap", on); });
          },
        };
      },
    },
    table: {
      size: [940, 620],
      render(f, win) {
        const rows = csv(f.text || "", /\.tsv$/i.test(f.name));
        const head = rows[0] || [], data = rows.slice(1), cols = Math.max(head.length, ...data.map(r => r.length));
        const numeric = Array.from({ length: cols }, (_, c) => { const v = data.map(r => r[c] ?? "").filter(x => x.trim() && x.trim() !== "-"); return v.length > 0 && v.filter(x => !isNaN(asNum(x))).length / v.length >= .8; });
        let sort = { c: -1, dir: 1 };
        const body = () => {
          const order = data.map((r, i) => i);
          if (sort.c >= 0) order.sort((a, b) => {
            const x = data[a][sort.c] ?? "", y = data[b][sort.c] ?? "";
            if (numeric[sort.c]) { const p = asNum(x), q = asNum(y); return ((isNaN(p) ? -Infinity : p) - (isNaN(q) ? -Infinity : q)) * sort.dir; }
            return x.localeCompare(y, undefined, { numeric: true, sensitivity: "base" }) * sort.dir;
          });
          return order.map(i => `<tr><th scope="row">${i + 1}</th>${Array.from({ length: cols }, (_, c) => `<td${numeric[c] ? ' class="n"' : ""}>${esc(data[i][c] ?? "")}</td>`).join("")}</tr>`).join("");
        };
        const headHtml = () => `<tr><th class="rn" aria-label="Row"></th>${Array.from({ length: cols }, (_, c) => `<th scope="col"${sort.c === c ? ` aria-sort="${sort.dir > 0 ? "ascending" : "descending"}"` : ""}${numeric[c] ? ' class="n"' : ""}><button type="button" data-col="${c}">${esc(head[c] ?? "Column " + (c + 1))}<svg viewBox="0 0 10 10" aria-hidden="true"><path d="m2.5 4 2.5-2.5L7.5 4M2.5 6 5 8.5 7.5 6" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button></th>`).join("")}</tr>`;
        return {
          body: `<table class="tb"><thead>${headHtml()}</thead><tbody>${body()}</tbody></table>`,
          foot: `<span>${data.length.toLocaleString("en")} row${data.length === 1 ? "" : "s"}</span><span>${cols} column${cols === 1 ? "" : "s"}</span><span class="tb-sort"></span>`,
          scroller: ".ha-body",
          mount() {
            const t = win.querySelector(".tb"), note = win.querySelector(".tb-sort");
            t.addEventListener("click", e => {
              const b = e.target.closest("[data-col]"); if (!b) return;
              const c = +b.dataset.col;
              sort = sort.c === c ? (sort.dir > 0 ? { c, dir: -1 } : { c: -1, dir: 1 }) : { c, dir: 1 };
              t.tHead.innerHTML = headHtml(); t.tBodies[0].innerHTML = body();
              note.textContent = sort.c >= 0 ? `Sorted by ${head[sort.c] ?? "column " + (sort.c + 1)}, ${sort.dir > 0 ? "ascending" : "descending"}` : "";
              t.querySelector(`[data-col="${c}"]`)?.focus();
            });
          },
        };
      },
    },
    image: {
      size: [1060, 760],
      render(f, win) {
        let fit = true, z = 1, x = 0, y = 0, nat = null;
        return {
          tools: `<button type="button" class="ha-tool" data-fit aria-pressed="true" title="Fit to window"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Fit</span></button><button type="button" class="ha-tool" data-one aria-pressed="false" title="Actual size"><span>100%</span></button>`,
          body: `<div class="iv-wall"><div class="iv-pan"><img class="iv-img" alt="${esc(f.name)}" src="${esc(f.src)}" draggable="false"></div><div class="iv-none" hidden>${ICON.image}<b>${esc(f.name)}</b><small>The picture is not included in this demo.</small></div></div>`,
          foot: `<span class="iv-dim">${esc(f.px || "")}</span><span>${esc(f.size)}</span><span class="iv-z">Fit</span>`,
          mount() {
            const wall = win.querySelector(".iv-wall"), pan = win.querySelector(".iv-pan"), img = win.querySelector(".iv-img"), zl = win.querySelector(".iv-z"), dim = win.querySelector(".iv-dim");
            const bFit = win.querySelector("[data-fit]"), bOne = win.querySelector("[data-one]");
            const base = () => nat ? Math.max(.01, Math.min((wall.clientWidth - 80) / nat[0], (wall.clientHeight - 80) / nat[1], 1)) : 1;
            const paint = () => {
              const s = base() * z; img.style.width = nat ? nat[0] * base() + "px" : "";
              pan.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
              zl.textContent = fit ? `Fit, ${Math.round(s * 100)}%` : `${Math.round(s * 100)}%`;
              bFit.setAttribute("aria-pressed", fit); bOne.setAttribute("aria-pressed", !fit && Math.abs(s - 1) < .005);
              wall.classList.toggle("grab", !fit);
            };
            img.addEventListener("load", () => { nat = [img.naturalWidth, img.naturalHeight]; dim.textContent = `${nat[0]} × ${nat[1]} px`; paint(); win.classList.add("iv-ready"); });
            img.addEventListener("error", () => { pan.hidden = true; win.querySelector(".iv-none").hidden = false; zl.textContent = ""; bFit.disabled = bOne.disabled = true; });
            bFit.addEventListener("click", () => { fit = true; z = 1; x = y = 0; paint(); });
            bOne.addEventListener("click", () => { fit = false; z = 1 / base(); x = y = 0; paint(); });
            wall.addEventListener("wheel", e => {
              if (!nat) return; e.preventDefault();
              const r = wall.getBoundingClientRect(), cx = e.clientX - r.left - r.width / 2, cy = e.clientY - r.top - r.height / 2;   // the window is settled by the time a wheel turns
              const nz = Math.min(12, Math.max(.25, z * Math.exp(-e.deltaY * .0016)));
              x = cx - (cx - x) * nz / z; y = cy - (cy - y) * nz / z; z = nz; fit = Math.abs(z - 1) < .01 && !x && !y; paint();
            }, { passive: false });
            let drag = null;
            wall.addEventListener("pointerdown", e => { if (e.button || !nat) return; drag = [e.clientX - x, e.clientY - y]; wall.setPointerCapture(e.pointerId); wall.classList.add("dragging"); });
            wall.addEventListener("pointermove", e => { if (!drag) return; x = e.clientX - drag[0]; y = e.clientY - drag[1]; fit = false; paint(); });
            const end = () => { drag = null; wall.classList.remove("dragging"); };
            wall.addEventListener("pointerup", end); wall.addEventListener("pointercancel", end);
            this.resize = paint;
          },
        };
      },
    },
    video: {
      size: [1280, 760], cinema: true,
      render(f, win) {
        let vid = null, idle = 0;
        const none = poster => poster ? `<img class="vp-poster" src="${esc(poster)}" alt="">` : `<div class="vp-none">${ICON.video}<b>${esc(f.name)}</b><small>The film is not included in this demo.</small></div>`;
        return {
          body: `<div class="vp-stage">${f.src ? `<video src="${esc(f.src)}"${f.poster ? ` poster="${esc(f.poster)}"` : ""} controls playsinline preload="auto"></video>` : none(null)}</div>`,
          foot: "",
          mount() {
            vid = win.querySelector("video");
            const wake = () => { win.classList.remove("vp-idle"); clearTimeout(idle); if (vid && !vid.paused) idle = setTimeout(() => win.classList.add("vp-idle"), 1800); };
            win.addEventListener("pointermove", wake); win.addEventListener("keydown", wake);
            if (!vid) return;
            vid.addEventListener("play", wake); vid.addEventListener("pause", wake);
            vid.addEventListener("error", () => {
              const stage = win.querySelector(".vp-stage");
              if (!f.poster) { stage.innerHTML = none(null); vid = null; return; }
              const p = new Image(); p.onload = () => { stage.innerHTML = none(f.poster); }; p.onerror = () => { stage.innerHTML = none(null); }; p.src = f.poster; vid = null;
            }, { once: true });
            const go = vid.play(); if (go && go.catch) go.catch(() => { /* blocked or missing: the controls stay */ });
          },
          key(e) {
            const t = e.target;
            if (e.key === " " && !t.closest?.("button") && t.tagName !== "VIDEO" && vid) { e.preventDefault(); vid.paused ? vid.play().catch(() => {}) : vid.pause(); return true; }
            if ((e.key === "f" || e.key === "F") && !e.ctrlKey && !e.metaKey && !e.altKey && document.fullscreenEnabled) {
              e.preventDefault();
              if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); else win.requestFullscreen?.().catch(() => {});
              return true;
            }
            return false;
          },
          close() { clearTimeout(idle); if (vid) { vid.pause(); vid.removeAttribute("src"); vid.load(); } if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); },
        };
      },
    },
    audio: {
      size: [560, 400],
      render(f) {
        const kind = (extOf(f.name) || "audio").toUpperCase();
        return {
          body: `<div class="ap"><div class="ap-art" aria-hidden="true">${ICON.audio}</div><div class="ap-id"><b>${esc(f.name.replace(/\.[^.]+$/, ""))}</b><small>${esc(kind)} audio${f.date ? `, recorded ${esc(fmtWhen(f.date))}` : ""}</small></div>`
            + `<div class="ap-wave">${waveform(f.name)}</div>`
            + `<div class="ap-tr"><button type="button" class="ap-play" disabled aria-label="Play (no audio in this demo)"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.4v9.2c0 .5.5.7.9.5l7-4.6a.6.6 0 0 0 0-1L5.9 2.9c-.4-.2-.9 0-.9.5z" fill="currentColor"/></svg></button><span class="ap-t">0:00</span><span class="ap-bar" aria-hidden="true"></span><span class="ap-t">${esc(f.duration || "")}</span></div>`
            + `<p class="ap-q">This demo carries no audio.</p></div>`,
          foot: `<span>${esc(f.size)}</span><span>${esc(kind)}</span>${f.duration ? `<span>${esc(f.duration)}</span>` : ""}`,
        };
      },
    },
    document: {
      size: [560, 720],
      render(f) {
        const ext = (extOf(f.name) || "file").toUpperCase();
        return {
          body: `<div class="dv-desk"><div class="dv-page"><span class="dv-tag">${esc(ext)}</span><b>${esc(f.name.replace(/\.[^.]+$/, ""))}</b><dl><dt>Size</dt><dd>${esc(f.size || "Unknown")}</dd>${f.date ? `<dt>Modified</dt><dd>${esc(fmtWhen(f.date))}</dd>` : ""}<dt>Location</dt><dd>${esc(f.path.replace(/\/[^/]*$/, "") || "/")}</dd></dl><p>Not included in this demo.</p></div></div>`,
          foot: `<span>${esc(ext)}</span><span>${esc(f.size)}</span>`,
        };
      },
    },
  };


  /* ---------------- the escape room's locks ----------------
     A *.lock file is JSON, either plain or encoded as "TXLOCK1\n" + base64(UTF-8 JSON) so that previews and search
     cannot read the answers: { lock, kind: "digits" | "word" | "dial", length, prompt, answer, hints: [3], final?,
     opens: { title, text (markdown), image?, reveal?: [paths] } }. `length` is the normalised answer's length: digits
     and word show that many wheels or tiles; a dial with a digits-only answer is that many brass 0-9 dials (any other
     dial answer, such as "12-34-5", is a rotary dial). Answers compare after normalising (case, spaces and punctuation
     dropped). The page remembers solved locks (opts.locks), and a solved lock reopens on its contents; a reveal path
     takes the explorer's pane there (opts.navigate, folders and files alike). */
  const normal = s => String(s ?? "").normalize("NFKD").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
  function lockJSON(text) {
    const t = String(text ?? "").trim();
    if (!/^TXLOCK1\s/.test(t)) return t;
    try {   // base64 to bytes, then the bytes as UTF-8 (atob alone would leave a byte string)
      const bin = atob(t.slice(7).replace(/\s+/g, ""));
      return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
    } catch (_) { return null; }
  }
  function readLock(text) {
    let o; try { o = JSON.parse(lockJSON(text)); } catch (_) { return null; }
    if (!o || typeof o !== "object" || o.answer == null) return null;
    const kind = ["digits", "word", "dial"].includes(o.kind) ? o.kind : "word";
    const wheels = kind === "digits" || (kind === "dial" && /^\d{1,8}$/.test(normal(o.answer)));
    const dialNums = kind === "dial" && !wheels ? String(o.answer).match(/\d+/g) || [] : [];
    const length = Math.max(1, Math.min(kind === "dial" ? 8 : 16, Number.isInteger(o.length) && o.length > 0 ? o.length : dialNums.length || normal(o.answer).length || 4));
    const opens = o.opens && typeof o.opens === "object" ? o.opens : {};
    return { id: String(o.lock || ""), kind, wheels, length, prompt: String(o.prompt || ""), answer: String(o.answer), final: o.final === true,
      hints: (Array.isArray(o.hints) ? o.hints : []).slice(0, 3).map(String),
      dialMax: dialNums.some(n => +n >= 40) ? 100 : 40,
      opens: { title: String(opens.title || "Open"), text: String(opens.text || ""), image: typeof opens.image === "string" ? opens.image : null,
        reveal: (Array.isArray(opens.reveal) ? opens.reveal : []).filter(x => typeof x === "string" && x.startsWith("/")) } };
  }
  const PADLOCK = `<svg class="lk-pad" viewBox="0 0 120 140" aria-hidden="true"><defs>
      <linearGradient id="lk-body" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f6dc8c"/><stop offset=".45" stop-color="#d9a744"/><stop offset="1" stop-color="#a87521"/></linearGradient>
      <linearGradient id="lk-steel" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#8e939c"/><stop offset=".35" stop-color="#eef0f3"/><stop offset=".6" stop-color="#b3b8c0"/><stop offset="1" stop-color="#7b8089"/></linearGradient></defs>
    <path class="lk-shackle" d="M34 66V44a26 26 0 0 1 52 0v22" fill="none" stroke="url(#lk-steel)" stroke-width="13" stroke-linecap="round"/>
    <rect x="16" y="62" width="88" height="70" rx="14" fill="url(#lk-body)"/>
    <rect x="16.5" y="62.5" width="87" height="69" rx="13.5" fill="none" stroke="rgba(255,255,255,.45)"/>
    <path d="M22 70h76" stroke="rgba(255,255,255,.5)" stroke-width="2" stroke-linecap="round"/>
    <circle cx="60" cy="92" r="9" fill="#4a3510"/><path d="M57 98h6l2 16h-10z" fill="#4a3510"/></svg>`;
  APPS.lock = {
    size: [600, 720],
    render(f, win, opts = {}) {
      const L = readLock(f.text), store = opts.locks || { solved: () => false, solve() {}, count: () => 0, total: 0 };
      const progress = () => store.total ? (store.count() >= store.total ? `All ${store.total} locks open` : `${store.count()} of ${store.total} locks open`) : "";
      if (!L) return { body: `<div class="lk"><div class="lk-head">${PADLOCK}<p class="lk-prompt">This lock's file could not be read.</p></div></div>`, foot: `<span>${esc(f.size)}</span>` };
      const key = L.id || f.path;
      let hintsShown = 0, value = L.wheels ? Array(L.length).fill(0) : L.kind === "dial" ? [] : Array(L.length).fill(""), dialAt = 0;
      const field = () => {
        if (L.wheels) return `<div class="lk-wheels${L.kind === "dial" ? " brass" : ""}" role="group" aria-label="Combination, ${L.length} ${L.kind === "dial" ? "dials" : "digits"}">${value.map((d, i) => `<div class="lk-wheel" role="spinbutton" tabindex="0" aria-valuemin="0" aria-valuemax="9" aria-valuenow="${d}" aria-label="Digit ${i + 1}" data-i="${i}"><button type="button" class="lk-up" tabindex="-1" aria-hidden="true"><svg viewBox="0 0 12 8"><path d="m2 6 4-4 4 4"/></svg></button><span class="lk-drum"><i>${(d + 9) % 10}</i><b>${d}</b><i>${(d + 1) % 10}</i></span><button type="button" class="lk-dn" tabindex="-1" aria-hidden="true"><svg viewBox="0 0 12 8"><path d="m2 2 4 4 4-4"/></svg></button></div>`).join("")}</div>`;
        if (L.kind === "word") return `<div class="lk-tiles${L.length > 8 ? " many" : ""}" role="group" aria-label="Answer, ${L.length} letters">${value.map((c, i) => `<input class="lk-tile" maxlength="1" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="Letter ${i + 1}" data-i="${i}" value="${esc(c)}">`).join("")}</div>`;
        const ticks = Array.from({ length: L.dialMax }, (_, n) => `<i style="--a:${n * 360 / L.dialMax}deg"${n % 5 === 0 ? ` class="maj" data-n="${n}"` : ""}></i>`).join("");
        return `<div class="lk-dialbox"><div class="lk-dial" tabindex="0" role="slider" aria-label="Dial" aria-valuemin="0" aria-valuemax="${L.dialMax - 1}" aria-valuenow="0"><div class="lk-face">${ticks}<span class="lk-knob"></span></div><span class="lk-mark" aria-hidden="true"></span><output class="lk-now">0</output></div>
          <div class="lk-seq"><span class="lk-seq-l">Numbers set</span><span class="lk-chips"></span><button type="button" class="lk-set">Set ${"<b>0</b>"}</button><button type="button" class="lk-clear">Clear</button></div></div>`;
      };
      const opened = () => {
        const o = L.opens, md = markdown(o.text).html, all = store.total && store.count() >= store.total;
        return `<div class="lk-open${L.final ? " final" : ""}">${L.final && all ? `<p class="lk-all"><i aria-hidden="true"></i>All ${store.total} locks open</p>` : ""}<h3>${esc(o.title)}</h3>${o.image ? `<img class="lk-img" src="${esc(o.image)}" alt="">` : ""}<div class="md-doc lk-md">${md}</div>${o.reveal.length && !L.final ? `<div class="lk-reveal">${o.reveal.map(p => `<button type="button" class="lk-go" data-go="${esc(p)}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5c0-.8.6-1.4 1.4-1.4h2.6l1.4 1.5h4.2c.8 0 1.4.6 1.4 1.4v5.6c0 .8-.6 1.4-1.4 1.4H3.9c-.8 0-1.4-.6-1.4-1.4z" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>Go to ${esc(p.split("/").filter(Boolean).pop() || p)}<small>${esc(p)}</small></button>`).join("")}</div>` : ""}</div>`;
      };
      const solvedBefore = store.solved(key);
      return {
        body: `<div class="lk${solvedBefore ? " is-open" + (L.final ? " finale words" : "") : ""}" data-kind="${L.kind}"><div class="lk-head">${PADLOCK}<p class="lk-prompt">${inline(L.prompt)}</p></div>
          <div class="lk-play"><form class="lk-form" novalidate>${field()}<div class="lk-row"><button type="submit" class="lk-try">Try it</button><button type="button" class="lk-hint"${L.hints.length ? "" : " hidden"}>Hint <span>1 of ${L.hints.length}</span></button></div>
          <p class="lk-msg" role="status" aria-live="polite"></p><ol class="lk-hints"></ol></form></div>
          <div class="lk-after">${solvedBefore ? opened() : ""}</div></div>`,
        foot: `<span class="lk-state">${solvedBefore ? "Open" : "Locked"}</span><span>${L.wheels && L.kind === "dial" ? `${L.length} brass dials` : { digits: `${L.length}-digit combination`, word: `${L.length}-letter word`, dial: `Dial, ${L.length} numbers` }[L.kind]}</span>${store.total ? `<span class="lk-prog">${progress()}</span>` : ""}`,
        scroller: ".ha-body",
        mount() {
          const root = win.querySelector(".lk"), msg = win.querySelector(".lk-msg"), after = win.querySelector(".lk-after");
          const reveal = () => after.querySelectorAll("[data-go]").forEach(b => b.addEventListener("click", () => opts.navigate?.(b.dataset.go)));
          if (solvedBefore) { reveal(); return; }
          const form = win.querySelector(".lk-form");
          // digits: wheels turn by click, wheel, arrows or typing
          const paintWheel = (w, d) => { w.setAttribute("aria-valuenow", d); w.querySelector(".lk-drum").innerHTML = `<i>${(d + 9) % 10}</i><b>${d}</b><i>${(d + 1) % 10}</i>`; };
          const turn = (i, by) => {
            const w = win.querySelector(`.lk-wheel[data-i="${i}"]`); value[i] = (value[i] + by + 10) % 10; paintWheel(w, value[i]);
            if (!reduce()) { w.classList.remove("up", "dn"); void w.offsetWidth; w.classList.add(by > 0 ? "up" : "dn"); }
          };
          win.querySelectorAll(".lk-wheel").forEach(w => {
            const i = +w.dataset.i;
            w.querySelector(".lk-up").addEventListener("click", () => { turn(i, -1); w.focus(); });
            w.querySelector(".lk-dn").addEventListener("click", () => { turn(i, 1); w.focus(); });
            w.addEventListener("wheel", e => { e.preventDefault(); turn(i, e.deltaY > 0 ? 1 : -1); }, { passive: false });
            w.addEventListener("keydown", e => {
              const all = [...win.querySelectorAll(".lk-wheel")];
              if (e.key === "ArrowUp") { e.preventDefault(); turn(i, -1); }
              else if (e.key === "ArrowDown") { e.preventDefault(); turn(i, 1); }
              else if (e.key === "ArrowRight") { e.preventDefault(); all[Math.min(all.length - 1, i + 1)].focus(); }
              else if (e.key === "ArrowLeft") { e.preventDefault(); all[Math.max(0, i - 1)].focus(); }
              else if (/^\d$/.test(e.key)) { e.preventDefault(); value[i] = +e.key; paintWheel(w, value[i]); (all[i + 1] || win.querySelector(".lk-try")).focus(); }
            });
          });
          // word: one letter a tile, moving on as you type
          win.querySelectorAll(".lk-tile").forEach(t => {
            const i = +t.dataset.i, all = () => [...win.querySelectorAll(".lk-tile")];
            t.addEventListener("input", () => { t.value = t.value.slice(-1).toUpperCase(); value[i] = t.value; if (t.value) (all()[i + 1] || win.querySelector(".lk-try")).focus(); });
            t.addEventListener("keydown", e => {
              if (e.key === "Backspace" && !t.value && i > 0) { e.preventDefault(); const p = all()[i - 1]; p.value = ""; value[i - 1] = ""; p.focus(); }
              else if (e.key === "ArrowLeft" && i > 0) { e.preventDefault(); all()[i - 1].focus(); }
              else if (e.key === "ArrowRight" && all()[i + 1]) { e.preventDefault(); all()[i + 1].focus(); }
            });
            t.addEventListener("focus", () => t.select());
          });
          // dial: turn it (drag, wheel, arrows), set each number in turn
          const dial = win.querySelector(".lk-dial");
          if (dial) {
            const face = dial.querySelector(".lk-face"), now = dial.querySelector(".lk-now"), set = win.querySelector(".lk-set"), chips = win.querySelector(".lk-chips");
            const paint = () => { face.style.transform = `rotate(${-dialAt * 360 / L.dialMax}deg)`; now.textContent = dialAt; dial.setAttribute("aria-valuenow", dialAt); set.querySelector("b").textContent = dialAt; };
            const spin = by => { dialAt = (dialAt + by + L.dialMax) % L.dialMax; paint(); };
            const paintSeq = () => { chips.innerHTML = value.map(n => `<b>${n}</b>`).join("") + Array.from({ length: Math.max(0, L.length - value.length) }, () => "<i></i>").join(""); set.disabled = value.length >= L.length; };
            dial.addEventListener("keydown", e => {
              if (e.key === "ArrowRight" || e.key === "ArrowUp") { e.preventDefault(); spin(1); }
              else if (e.key === "ArrowLeft" || e.key === "ArrowDown") { e.preventDefault(); spin(-1); }
              else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); set.click(); }
            });
            dial.addEventListener("wheel", e => { e.preventDefault(); spin(e.deltaY > 0 ? 1 : -1); }, { passive: false });
            let drag = null;
            const angle = e => { const r = dial.getBoundingClientRect(); return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180 / Math.PI; };
            dial.addEventListener("pointerdown", e => { drag = { a: angle(e), at: dialAt }; dial.setPointerCapture(e.pointerId); dial.focus(); });
            dial.addEventListener("pointermove", e => { if (!drag) return; const d = angle(e) - drag.a; dialAt = ((drag.at - Math.round(d / (360 / L.dialMax))) % L.dialMax + L.dialMax) % L.dialMax; paint(); });
            const end = () => { drag = null; }; dial.addEventListener("pointerup", end); dial.addEventListener("pointercancel", end);
            set.addEventListener("click", () => { if (value.length < L.length) { value.push(dialAt); paintSeq(); } });
            win.querySelector(".lk-clear").addEventListener("click", () => { value = []; paintSeq(); dial.focus(); });
            paint(); paintSeq();
          }
          // hints, one at a time
          const hb = win.querySelector(".lk-hint"), list = win.querySelector(".lk-hints");
          hb.addEventListener("click", () => {
            if (hintsShown >= L.hints.length) return;
            const li = document.createElement("li"); li.innerHTML = inline(L.hints[hintsShown++]); list.append(li);
            hb.querySelector("span").textContent = hintsShown < L.hints.length ? `${hintsShown + 1} of ${L.hints.length}` : "none left";
            hb.disabled = hintsShown >= L.hints.length;
          });
          form.addEventListener("submit", e => {
            e.preventDefault();
            const rotary = L.kind === "dial" && !L.wheels, tried = rotary ? value.join("-") : value.join("");
            if (!rotary && value.some(v => v === "")) { msg.textContent = `All ${L.length} letters first.`; return; }
            if (rotary && value.length < L.length) { msg.textContent = `Set all ${L.length} numbers first.`; return; }
            const ok = rotary ? (String(L.answer).match(/\d+/g) || []).map(Number).join("-") === value.join("-") : normal(tried) === normal(L.answer);
            if (!ok) {
              msg.textContent = "Not that. The lock holds.";
              if (!reduce()) { root.classList.remove("shake"); void root.offsetWidth; root.classList.add("shake"); }
              return;
            }
            store.solve(key);
            msg.textContent = "Open.";
            win.querySelector(".lk-state").textContent = "Open";
            const prog = win.querySelector(".lk-prog"); if (prog) prog.textContent = progress();
            root.classList.add("opening");
            if (L.final) {   // the finale: slower and larger; the picture first, then the words
              root.classList.add("finale");
              opts.onFinale?.();
              setTimeout(() => {
                after.innerHTML = opened(); root.classList.add("is-open");
                setTimeout(() => root.classList.add("words"), reduce() ? 0 : 1600);
              }, reduce() ? 0 : 1500);
              return;
            }
            setTimeout(() => {
              after.innerHTML = opened(); reveal();
              root.classList.add("is-open");
              (after.querySelector(".lk-go") || after).focus?.({ preventScroll: true });
            }, reduce() ? 0 : 750);
          });
        },
      };
    },
  };

  /* ================================ the window ================================ */
  let cur = null;
  const scrim = document.createElement("div");
  scrim.className = "ha-scrim";
  document.body.append(scrim);

  const focusables = el => [...el.querySelectorAll('button:not([disabled]), [href], input, textarea, select, video[controls], [tabindex]:not([tabindex="-1"])')].filter(x => !x.closest("[hidden]") && x.offsetParent !== null);

  function place(win, id) {
    if (small()) { win.style.cssText = ""; win.classList.add("ha-full"); return; }
    win.classList.remove("ha-full");
    const [w0, h0] = APPS[id].size, W = innerWidth, H = innerHeight, m = id === "video" ? 32 : 48;
    const w = Math.min(w0, W - m * 2), h = Math.min(h0, H - m * 2);
    win.style.width = w + "px"; win.style.height = h + "px";
    win.style.left = Math.round((W - w) / 2) + "px"; win.style.top = Math.round((H - h) / 2) + "px";
  }
  function flipFrom(win, o) {   // a transform that puts the window over the file it came from
    const r = win.getBoundingClientRect();
    if (!o || !r.width) return "translateY(16px) scale(.96)";
    const sx = Math.max(.04, o.w / r.width), sy = Math.max(.02, o.h / r.height);
    return `translate(${o.x + o.w / 2 - (r.left + r.width / 2)}px, ${o.y + o.h / 2 - (r.top + r.height / 2)}px) scale(${sx}, ${sy})`;
  }

  function open(file, opts = {}) {
    if (cur) close({ instant: true });
    const id = appFor(file), def = APPS[id];
    const win = document.createElement("section");
    win.className = `ha-win ha-${id}`;
    win.setAttribute("role", "dialog"); win.setAttribute("aria-modal", "true"); win.tabIndex = -1;
    const tid = "ha-t-" + Math.random().toString(36).slice(2, 8);
    win.setAttribute("aria-labelledby", tid);
    const part = def.render(file, win, opts);
    win.innerHTML = `<header class="ha-bar"><span class="ha-ic" aria-hidden="true">${ICON[id]}</span><h2 class="ha-ttl" id="${tid}"><b>${esc(file.name)}</b><small>${NAME[id]}</small></h2>`
      + `<div class="ha-tools">${part.tools || ""}</div>`
      + `<div class="ha-ctl"><span class="ha-c ha-min" aria-hidden="true"><svg viewBox="0 0 12 12"><path d="M2.5 6h7"/></svg></span><span class="ha-c ha-max" aria-hidden="true"><svg viewBox="0 0 12 12"><rect x="2.5" y="2.5" width="7" height="7" rx="1"/></svg></span><button type="button" class="ha-c ha-x" aria-label="Close ${esc(NAME[id])}"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 3 6 6M9 3 3 9"/></svg></button></div></header>`
      + `<div class="ha-body">${part.body}</div>${part.foot ? `<footer class="ha-foot">${part.foot}</footer>` : ""}`;
    document.body.append(win);
    place(win, id);
    const inert = opts.inert || [];
    for (const el of inert) el.inert = true;
    document.body.classList.add("ha-open"); document.body.classList.toggle("ha-cinema", !!def.cinema);
    scrim.classList.add("on");
    cur = { win, id, part, file, opts, inert, drag: null, onResize: null };
    part.mount?.();

    // grows out of the file it was opened from
    if (!reduce()) {
      win.style.transition = "none"; win.style.opacity = "0"; win.style.transform = flipFrom(win, opts.origin);
      win.getBoundingClientRect();
      win.style.transition = ""; win.style.opacity = ""; win.style.transform = "";
    }
    win.querySelector(".ha-x").addEventListener("click", () => close());
    win.addEventListener("keydown", e => {
      if (cur?.win !== win) return;
      if (part.key?.(e)) return;
      if (e.key === "Escape") { if (document.fullscreenElement) return; e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key === "Tab") {
        const f = focusables(win); if (!f.length) { e.preventDefault(); return; }
        const i = f.indexOf(document.activeElement);
        if (e.shiftKey && (i <= 0)) { e.preventDefault(); f.at(-1).focus(); }
        else if (!e.shiftKey && (i === f.length - 1 || i < 0)) { e.preventDefault(); f[0].focus(); }
      }
    });
    // dragged by the title bar
    const bar = win.querySelector(".ha-bar");
    bar.addEventListener("pointerdown", e => {
      if (e.button || e.target.closest("button, .ha-tools") || win.classList.contains("ha-full")) return;
      const r = win.getBoundingClientRect();
      cur.drag = [e.clientX - r.left, e.clientY - r.top];
      bar.setPointerCapture(e.pointerId); win.classList.add("ha-dragging");
    });
    bar.addEventListener("pointermove", e => {
      if (!cur?.drag) return;
      const w = win.offsetWidth, x = Math.min(innerWidth - 80, Math.max(80 - w, e.clientX - cur.drag[0])), y = Math.min(innerHeight - 40, Math.max(0, e.clientY - cur.drag[1]));
      win.style.left = x + "px"; win.style.top = y + "px";
    });
    const endDrag = () => { if (cur) cur.drag = null; win.classList.remove("ha-dragging"); };
    bar.addEventListener("pointerup", endDrag); bar.addEventListener("pointercancel", endDrag);
    cur.onResize = () => { if (small() || win.classList.contains("ha-full")) place(win, id); part.resize?.(); };
    if (part.scroller) { const s = win.querySelector(part.scroller); s.tabIndex = 0; s.setAttribute("aria-label", file.name); }
    ((part.scroller && win.querySelector(part.scroller)) || win).focus({ preventScroll: true });
    return id;
  }

  function close({ instant = false } = {}) {
    if (!cur) return;
    const { win, part, opts, inert, file } = cur;
    cur = null;
    part.close?.();
    for (const el of inert) el.inert = false;
    document.body.classList.remove("ha-open", "ha-cinema");
    scrim.classList.remove("on");
    const done = () => { win.remove(); };
    if (instant || reduce()) done();
    else {
      win.classList.add("ha-closing");
      // the file's place may come back through a bridge: wait briefly, else return to where it opened from
      Promise.race([Promise.resolve(opts.locate?.(file.path)).catch(() => null), new Promise(r => setTimeout(r, 120))]).then(o => {
        win.style.transform = flipFrom(win, o || opts.origin); win.style.opacity = "0";
        setTimeout(done, 280);
      });
    }
    if (!instant) opts.onClose?.();
  }
  scrim.addEventListener("click", () => close());
  addEventListener("resize", () => cur?.onResize?.());

  window.HostApps = { open, close, isOpen: () => !!cur, appFor, NAME, markdown, csv };
})();
