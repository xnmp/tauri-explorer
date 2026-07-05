/* Tauri Explorer showcase — the site IS the app.
   A fake filesystem holds the marketing copy; quick-open, the command
   palette and the cheatsheet all actually work. */

"use strict";

const REPO = "https://github.com/xnmp/tauri-explorer";
const REL = `${REPO}/releases/latest/download`;
const VERSION = "1.0.1";

const DL = {
  linux: `${REL}/tauri-explorer_${VERSION}_amd64.AppImage`,
  deb: `${REL}/tauri-explorer_${VERSION}_amd64.deb`,
  rpm: `${REL}/tauri-explorer-${VERSION}-1.x86_64.rpm`,
  win: `${REL}/tauri-explorer_${VERSION}_x64_en-US.msi`,
  mac: `${REL}/tauri-explorer_${VERSION}_aarch64.dmg`,
};

const THEMES = [
  { id: "light", label: "Daylight" },
  { id: "dark", label: "Midnight" },
  { id: "aurora", label: "Aurora" },
  { id: "hacker", label: "Hacker" },
  { id: "solarized", label: "Solarized Light" },
];

/* The inline <head> script sets data-theme before first paint; from here on
   a theme is only persisted once the user actually picks one. */
function applyTheme(theme, opts = {}) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("theme", theme);
  renderThemeMenu();
  if (opts.announce) {
    const t = THEMES.find((x) => x.id === theme);
    toast(`Theme: <strong>${t ? t.label : theme}</strong> — in the app, themes are plain CSS files. Ship your own.`, { ms: 3200 });
  }
}
/** Ctrl+T cycles the palette-selectable themes, like flipping through the app's. */
function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme");
  const idx = THEMES.findIndex((t) => t.id === current);
  applyTheme(THEMES[(idx + 1) % THEMES.length].id, { announce: true });
}

function shot(src, caption) {
  return `<figure style="margin:0"><img src="img/${src}" alt="${caption}" loading="lazy" decoding="async" /><figcaption>${caption}</figcaption></figure>`;
}

/* Image entries for the screenshots/ folder — rendered as tiles with live
   thumbnails, the same trick the app does natively (Rust-built, disk-cached). */
function shotFile(file, size, caption) {
  return {
    name: file, kind: "img", size, thumb: `img/${file}`,
    content: `
<h1>${file}</h1>
<p class="lede">${caption}</p>
<figure style="margin:0"><img src="img/${file}" alt="${caption}" decoding="async" /></figure>
<p class="note">This folder is the thumbnail demo: the app generates thumbnails
in the Rust backend into an on-disk cache, so image-heavy folders scroll at
60fps. Here your browser does the honors.</p>`,
  };
}

/* ── The filesystem ─────────────────────────────────────── */

const FS = {
  name: "tauri-explorer",
  kind: "dir",
  children: [
    {
      name: "README.md", kind: "file", size: "4 KB", badge: "start",
      content: `
<h1>A file manager with Ctrl+P.</h1>
<p class="lede">If you've ever opened your editor just to move files faster than your file
manager lets you, this is for you.</p>
<p>Tauri Explorer brings the editor workflow to the filesystem: fuzzy file
open with frecency ranking, ripgrep-backed content search, a command palette
for every action, fully rebindable keys, and a UI you can strip down to
nothing.</p>
<p><strong>You're using it right now.</strong> This page is a working copy of the app —
the sidebar, the list, this preview pane. Press <kbd>Ctrl+P</kbd> and type
<code>git</code>. That reflex is the product.</p>
<div class="dl-row">
  <a class="dl-btn" href="${DL.linux}">Download for Linux</a>
  <a class="dl-btn ghost" href="${DL.win}">Windows</a>
  <a class="dl-btn ghost" href="${DL.mac}">macOS</a>
</div>
<p class="note">Free and MIT-licensed. No account, no telemetry — see <code>trust/</code>.</p>
${shot("details-view.png", "The real thing: details view, git status column, breadcrumb bar.")}
`,
    },
    {
      name: "INSTALL.md", kind: "file", size: "2 KB",
      content: `
<h1>Install</h1>
<h2>Linux</h2>
<div class="dl-row">
  <a class="dl-btn" href="${DL.linux}">AppImage</a>
  <a class="dl-btn ghost" href="${DL.deb}">.deb</a>
  <a class="dl-btn ghost" href="${DL.rpm}">.rpm</a>
</div>
<pre><code>chmod +x tauri-explorer_${VERSION}_amd64.AppImage
./tauri-explorer_${VERSION}_amd64.AppImage</code></pre>
<p>Arch users: a <code>PKGBUILD</code> ships in the repo.</p>
<h2>Windows</h2>
<div class="dl-row">
  <a class="dl-btn" href="${DL.win}">MSI installer</a>
  <a class="dl-btn ghost" href="${REL}/tauri-explorer_${VERSION}_x64-setup.exe">Setup .exe</a>
</div>
<h2>macOS (Apple Silicon)</h2>
<div class="dl-row"><a class="dl-btn" href="${DL.mac}">.dmg</a></div>
<p class="note">Binaries aren't code-signed yet, so Gatekeeper and SmartScreen
will warn on first launch — right-click → Open on macOS. It's open source;
audit it, or build from source with <code>bun</code> + <code>cargo</code>.</p>
`,
    },
    {
      name: "features", kind: "dir",
      children: [
        {
          name: "quick-open.md", kind: "file", size: "3 KB", badge: "Ctrl+P",
          content: `
<h1>Quick open</h1>
<p class="lede"><kbd>Ctrl+P</kbd>, type three letters, <kbd>Enter</kbd>. Anywhere on your disk.</p>
<p>Fuzzy matching over filenames with <strong>frecency ranking</strong> — the files you
touch often float to the top, like your editor's file switcher. Results
stream in as a background walker scans, so huge trees don't block the first
keystroke.</p>
<p>You just used the same interaction to open this file (or you can — press
<kbd>Esc</kbd>, then <kbd>Ctrl+P</kbd>, type <code>quick</code>).</p>
${shot("quick-open.png", "Quick open in the app, ranking by fuzzy score × recency.")}
`,
        },
        {
          name: "content-search.md", kind: "file", size: "3 KB", badge: "Ctrl+Shift+F",
          content: `
<h1>Content search</h1>
<p class="lede">ripgrep, wearing a dialog.</p>
<p><kbd>Ctrl+Shift+F</kbd> greps file <em>contents</em> under the current folder —
streaming results as they're found, grouped by file, hidden files skipped,
subdirectories recursed. Click a match to jump to the file.</p>
<p>It's the actual <code>ripgrep</code> engine in the Rust backend, not a JS
reimplementation — a warm search over a large project lands in tens of
milliseconds.</p>
${shot("content-search.png", "Ctrl+Shift+F in the app: streaming matches, grouped by file, filterable.")}
`,
        },
        {
          name: "command-palette.md", kind: "file", size: "3 KB", badge: "Ctrl+Shift+P",
          content: `
<h1>Command palette</h1>
<p class="lede">Every action in the app, one keystroke away.</p>
<p>New folder, bulk rename, toggle hidden files, set wallpaper, open
terminal, show the git graph, report a bug — everything is a palette
command with frecency-ranked search, and every command's shortcut is
rebindable in Settings.</p>
<p>This site has one too: <kbd>Ctrl+Shift+P</kbd> → try <em>"Toggle Zen Mode"</em>
or <em>"Theme: Aurora"</em>. The real one has ~80 commands.</p>
${shot("command-palette.png", "The app's palette: category tags, rebindable shortcuts, frecency ranking.")}
`,
        },
        {
          name: "tabs-and-panes.md", kind: "file", size: "3 KB",
          content: `
<h1>Tabs & dual pane</h1>
<p class="lede">Browser-grade tabs. Commander-grade panes.</p>
<ul>
  <li><kbd>Ctrl+T</kbd> tabs with Chrome-style fillets (look at this window's title bar)</li>
  <li>Drag a tab out → it detaches into a live window, mid-drag, like Chrome</li>
  <li>Drag tabs between windows and panes</li>
  <li><kbd>Ctrl+\\</kbd> splits into dual panes, <kbd>F5</kbd>/<kbd>F6</kbd> copy/move across</li>
</ul>
${shot("dual-pane.png", "Dual-pane mode: two independent tab strips, one keystroke apart.")}
`,
        },
        {
          name: "git-graph.md", kind: "file", size: "4 KB", badge: "unusual",
          content: `
<h1>Git, in a file manager</h1>
<p class="lede">Your file manager knows what changed. Why stop there?</p>
<p>Folders show git status badges; a source-control panel stages and commits;
and <em>Show Commit Graph</em> opens a full commit graph — continuous curved
branch lines, stashes, tags, local+remote combined refs, and right-click
checkout / merge / rebase / cherry-pick / branch-here. Behavioral parity
with the VSCode Git Graph extension, reimplemented in Svelte + libgit2.</p>
${shot("git-graph.png", "The commit graph on a criss-cross merge history, stash ring included.")}
${shot("scm-panel.png", "The source-control panel: stage, unstage, commit.")}
`,
        },
        {
          name: "terminal.md", kind: "file", size: "2 KB", badge: "Ctrl+\`",
          content: `
<h1>Integrated terminal</h1>
<p class="lede"><kbd>Ctrl+\`</kbd>, exactly where your hands expect it.</p>
<p>A real PTY (xterm.js front, Rust portable-pty back) that opens in the
directory you're looking at. Close the panel, the shell session stays
alive. It's behind a feature flag if you'd rather not have it at all.</p>
${shot("terminal.png", "The terminal panel, themed with the app, opened at the folder you're viewing.")}
`,
        },
        {
          name: "views-and-themes.md", kind: "file", size: "3 KB",
          content: `
<h1>Views & themes</h1>
<p>Details, list, and tiles views — all three virtualized, so directories
with tens of thousands of entries scroll at 60fps. Thumbnails are generated
in Rust with an on-disk cache.</p>
${shot("tiles-view.png", "Tiles view with folder previews.")}
<p>Theming is plain CSS files — ship your own. Dark mode follows the system
or a palette command (<kbd>Ctrl+Shift+P</kbd> → "Toggle Dark/Light Theme" —
works on this page too).</p>
${shot("dark-theme.png", "Dark theme.")}
<p>And if you like your chrome minimal: the sidebar, status bar, address
bar and even the title bar each toggle off independently. Try it right
here — <kbd>Ctrl+Shift+P</kbd> → <em>"Toggle Zen Mode"</em>.</p>
${shot("minimal.png", "The same app with everything stripped off.")}
`,
        },
        {
          name: "keyboard-everything.md", kind: "file", size: "2 KB", badge: "Ctrl+/",
          content: `
<h1>Keyboard everything</h1>
<p class="lede">Every shortcut rebindable. Every action reachable without a mouse.</p>
<p>Type-ahead jumps to files as you type their name. <kbd>F2</kbd> renames (with
bulk rename over selections), <kbd>Space</kbd> previews, chorded bindings are
supported, and <kbd>Ctrl+/</kbd> shows a live cheatsheet of your actual
bindings — customizations included. Try it here.</p>
${shot("cheatsheet.png", "The in-app cheatsheet, generated from the live keymap.")}
`,
        },
        {
          name: "system-file-picker.md", kind: "file", size: "3 KB", badge: "linux",
          content: `
<h1>Be the system file picker</h1>
<p class="lede">On Linux, Tauri Explorer can replace the GTK file dialog.</p>
<p>It implements the <code>xdg-desktop-portal</code> FileChooser backend: when
Chrome asks where a download goes, the dialog that opens can be <em>this</em> —
with <kbd>Ctrl+P</kbd> fuzzy search inside the picker. One line in
<code>portals.conf</code>:</p>
<pre><code>org.freedesktop.impl.portal.FileChooser=tauri-explorer</code></pre>
${shot("file-picker.png", "The dialog your browser opens can be this: Miller columns, keyboard-first.")}
${shot("picker-quickopen.png", "Ctrl+P fuzzy search — inside the system file picker.")}
<p class="note">Windows and macOS don't allow replacing the system dialog —
this one is a Linux superpower.</p>
`,
        },
        {
          name: "ai-plugins.md", kind: "file", size: "2 KB", badge: "optional",
          content: `
<h1>AI, as plugins, off by default</h1>
<p>Rename suggestions from file contents, destination suggestions when
organizing, and image editing via Gemini — each an <em>optional plugin</em> you
enable per-feature with your own API key (or <code>GEMINI_API_KEY</code> env var,
never written to disk).</p>
${shot("ai-rename.png", "AI rename: pick from suggestions derived from the file's contents.")}
`,
        },
      ],
    },
    {
      name: "screenshots", kind: "dir", view: "tiles", badge: "thumbnails",
      children: [
        shotFile("details-view.png", "32 KB", "Details view — git status column, breadcrumb bar."),
        shotFile("tiles-view.png", "34 KB", "Tiles view with folder previews."),
        shotFile("quick-open.png", "22 KB", "Quick open, ranked by fuzzy score × recency."),
        shotFile("command-palette.png", "21 KB", "The command palette — every action, one keystroke away."),
        shotFile("content-search.png", "18 KB", "ripgrep content search, streaming results."),
        shotFile("git-graph.png", "39 KB", "The commit graph on a criss-cross merge history."),
        shotFile("scm-panel.png", "11 KB", "Source-control panel: stage, unstage, commit."),
        shotFile("dual-pane.png", "16 KB", "Dual-pane mode — two tab strips, one keystroke apart."),
        shotFile("terminal.png", "90 KB", "The integrated terminal, themed to match."),
        shotFile("dark-theme.png", "50 KB", "Dark theme."),
        shotFile("minimal.png", "38 KB", "Every bar toggled off — just files."),
        shotFile("cheatsheet.png", "35 KB", "The live shortcut cheatsheet."),
        shotFile("context-menu.png", "28 KB", "Context menu with git actions."),
        shotFile("ai-rename.png", "32 KB", "AI rename suggestions (optional plugin)."),
        shotFile("file-picker.png", "13 KB", "As the Linux system file picker."),
        shotFile("picker-quickopen.png", "25 KB", "Ctrl+P — inside the system file picker."),
      ],
    },
    {
      name: "trust", kind: "dir",
      children: [
        {
          name: "no-telemetry.md", kind: "file", size: "2 KB",
          content: `
<h1>No telemetry. Actually none.</h1>
<p>The app makes exactly two kinds of network requests, both visible in the
source: an optional once-a-day GitHub check for new releases, and AI plugin
calls if — and only if — you enable those plugins.</p>
<p>Crash reports are written to <em>local files</em>. After a crash, the app
offers to open a pre-filled GitHub issue <strong>in your browser</strong> — you see
every byte before it leaves your machine, and declining is one click.</p>
`,
        },
        {
          name: "open-source.md", kind: "file", size: "1 KB",
          content: `
<h1>MIT, end to end</h1>
<p>Rust + Tauri v2 backend, Svelte 5 frontend. ~830 unit tests, ~470
browser e2e tests (Chromium <em>and</em> WebKit), plus real-binary smoke suites
on Linux, Windows and macOS in CI.</p>
<p><a href="${REPO}">Read the source ↗</a> · <a href="${REPO}/blob/main/CHANGELOG.md">Changelog ↗</a> · <a href="${REPO}/issues/new">File a bug ↗</a></p>
`,
        },
      ],
    },
    {
      name: "CHANGELOG.md", kind: "file", size: "6 KB",
      content: `
<h1>v${VERSION}</h1>
<p>Highlights of the 1.0 line:</p>
<ul>
  <li>Per-pane tabs with live window detach</li>
  <li>Git commit graph with context actions</li>
  <li>Local crash reporting, update notices, shortcut cheatsheet</li>
  <li>macOS boot fix (1.0.1) — per-platform security scopes</li>
</ul>
<p><a href="${REPO}/blob/main/CHANGELOG.md">Full changelog on GitHub ↗</a></p>
`,
    },
  ],
};

/* ── State ──────────────────────────────────────────────── */

let cwd = [];               // array of dir names from root
let selectedName = null;
let history = [];
const $ = (id) => document.getElementById(id);

function nodeAt(pathArr) {
  let node = FS;
  for (const part of pathArr) {
    node = (node.children || []).find((c) => c.name === part && c.kind === "dir");
    if (!node) return FS;
  }
  return node;
}

function flatten(node = FS, prefix = []) {
  const out = [];
  for (const child of node.children || []) {
    const p = [...prefix, child.name];
    if (child.kind === "dir") out.push(...flatten(child, p));
    else out.push({ node: child, path: p });
  }
  return out;
}
const ALL_FILES = flatten();

/* ── Fuzzy matching (subsequence + bonus scoring) ───────── */

function fuzzy(query, text) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0, score = 0, run = 0;
  const hits = [];
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      hits.push(ti);
      run += 1;
      score += 2 + run * 2 + (ti === 0 || "-_./ ".includes(t[ti - 1]) ? 6 : 0);
      qi++;
    } else run = 0;
  }
  return qi === q.length ? { score: score - t.length * 0.05, hits } : null;
}

function highlight(text, hits) {
  let out = "", h = new Set(hits);
  for (let i = 0; i < text.length; i++) {
    out += h.has(i) ? `<mark>${text[i]}</mark>` : text[i];
  }
  return out;
}

/* ── Rendering ──────────────────────────────────────────── */

/* Inline SVG icons — no emoji-font dependence, matches the app's line style. */
const SVG = {
  folder: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" fill="color-mix(in srgb, currentColor 18%, transparent)"/></svg>',
  file: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>',
  readme: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M9 12h6M9 16h6"/></svg>',
  branch: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="7" cy="6" r="2.2"/><circle cx="7" cy="18" r="2.2"/><circle cx="17" cy="8" r="2.2"/><path d="M7 8.2v7.6M17 10.2c0 4-10 3-10 5.6"/></svg>',
  down: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 4v12m0 0 5-5m-5 5-5-5M5 20h14"/></svg>',
  app: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 9h18M8 4v5"/></svg>',
  img: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m5 19 5.5-5.5 3 3L17 13l4 4"/></svg>',
};

function iconFor(node) {
  if (node.kind === "dir") return SVG.folder;
  if (node.kind === "img") return SVG.img;
  if (node.name === "README.md") return SVG.readme;
  if (node.name.startsWith("git")) return SVG.branch;
  return SVG.file;
}

function render() {
  const here = nodeAt(cwd);

  // breadcrumb
  const bc = $("breadcrumb");
  bc.innerHTML = "";
  const mk = (label, target, isHere) => {
    const b = document.createElement("button");
    b.className = "crumb" + (isHere ? " here" : "");
    b.textContent = label;
    b.onclick = () => navigate(target);
    return b;
  };
  bc.appendChild(mk("tauri-explorer", [], cwd.length === 0));
  cwd.forEach((part, i) => {
    const sep = document.createElement("span");
    sep.className = "sep";
    sep.textContent = "›";
    bc.appendChild(sep);
    bc.appendChild(mk(part, cwd.slice(0, i + 1), i === cwd.length - 1));
  });

  // sidebar
  const sb = $("sidebar");
  sb.innerHTML = `<div class="side-head">EXPLORE</div>`;
  const sideEntry = (label, ico, target, active) => {
    const b = document.createElement("button");
    b.className = "side-item" + (active ? " active" : "");
    b.innerHTML = `<span class="ico">${ico}</span>${label}`;
    b.onclick = () => navigate(target);
    sb.appendChild(b);
  };
  sideEntry("tauri-explorer", SVG.app, [], cwd.length === 0);
  for (const child of FS.children.filter((c) => c.kind === "dir")) {
    sideEntry(child.name, SVG.folder, [child.name], cwd[0] === child.name);
  }
  const dl = document.createElement("div");
  dl.className = "side-head";
  dl.textContent = "GET IT";
  sb.appendChild(dl);
  const links = [
    ["Linux (AppImage)", DL.linux], ["Windows (.msi)", DL.win], ["macOS (.dmg)", DL.mac],
  ];
  for (const [label, href] of links) {
    const a = document.createElement("button");
    a.className = "side-item";
    a.innerHTML = `<span class="ico">${SVG.down}</span>${label}`;
    a.onclick = () => window.open(href, "_blank");
    sb.appendChild(a);
  }

  // file list — details rows, or tiles with live thumbnails
  const fl = $("filelist");
  const children = here.children || [];
  const tiles = here.view === "tiles";
  fl.classList.toggle("tiles", tiles);
  fl.innerHTML = tiles ? "" : `<div class="list-head"><span>NAME</span><span class="kind">KIND</span><span>SIZE</span></div>`;
  for (const child of children) {
    if (tiles) {
      const tile = document.createElement("button");
      tile.className = "tile" + (selectedName === child.name ? " selected" : "");
      tile.dataset.name = child.name;
      tile.innerHTML = `
        <img class="thumb" src="${child.thumb}" alt="${child.name}" loading="lazy" decoding="async" />
        <span class="tname">${child.name}</span>`;
      tile.onclick = () => openEntry(child);
      fl.appendChild(tile);
      continue;
    }
    const row = document.createElement("button");
    row.className = "row" + (selectedName === child.name ? " selected" : "");
    row.dataset.name = child.name;
    const badge = child.badge ? `<span class="try">${child.badge}</span>` : "";
    row.innerHTML = `
      <span class="name"><span class="ico">${iconFor(child)}</span><span class="fname">${child.name}</span>${badge}</span>
      <span class="meta kind">${child.kind === "dir" ? "Folder" : child.kind === "img" ? "PNG image" : "Markdown"}</span>
      <span class="meta">${child.kind === "dir" ? `${(child.children || []).length} items` : child.size || ""}</span>`;
    row.onclick = () => openEntry(child);
    fl.appendChild(row);
  }
  if (children.length === 0) {
    fl.insertAdjacentHTML("beforeend", `<div class="empty-dir">Empty folder</div>`);
  }

  $("status-left").textContent = tiles
    ? `${children.length} items · live thumbnails — the app bakes these in Rust, cached on disk`
    : `${children.length} items · you are inside the pitch — every file opens`;
}

function openEntry(node) {
  if (node.kind === "dir") {
    navigate([...cwd, node.name]);
    return;
  }
  selectedName = node.name;
  document.querySelectorAll(".row, .tile").forEach((r) =>
    r.classList.toggle("selected", r.dataset.name === node.name));
  $("preview").hidden = false;
  $("preview-name").textContent = [...cwd, node.name].join("/");
  $("preview-body").innerHTML = node.content;
  $("preview-body").scrollTop = 0;
}

function navigate(pathArr) {
  history.push(cwd);
  cwd = pathArr;
  selectedName = null;
  render();
  if (pathArr[0] === "screenshots")
    toastOnce("thumbs", "Every tile here is a live thumbnail — the app generates these natively, in Rust, cached on disk.");
}

/* ── Overlays ───────────────────────────────────────────── */

function overlay(id) {
  return {
    el: $(id),
    open() { this.el.hidden = false; const i = this.el.querySelector("input"); if (i) { i.value = ""; i.focus(); i.dispatchEvent(new Event("input")); } },
    close() { this.el.hidden = true; },
    get isOpen() { return !this.el.hidden; },
  };
}
const qo = overlay("qo-overlay");
const cp = overlay("cp-overlay");
const ks = overlay("ks-overlay");
const closeAll = () => { qo.close(); cp.close(); ks.close(); };

/* quick open */
let qoIndex = 0;
function qoRender() {
  const q = $("qo-input").value.trim();
  const list = $("qo-results");
  const scored = q
    ? ALL_FILES.map(({ node, path }) => {
        const m = fuzzy(q, path.join("/"));
        return m && { node, path, ...m };
      }).filter(Boolean).sort((a, b) => b.score - a.score)
    : ALL_FILES.map(({ node, path }) => ({ node, path, hits: [] }));
  qoIndex = Math.min(qoIndex, Math.max(0, scored.length - 1));
  list.innerHTML = "";
  if (!scored.length) {
    list.innerHTML = `<li class="nothing">No matches — the real app searches your whole disk.</li>`;
    return;
  }
  scored.slice(0, 12).forEach((r, i) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.className = i === qoIndex ? "active" : "";
    const joined = r.path.join("/");
    b.innerHTML = `<span class="ico">${iconFor(r.node)}</span><span>${highlight(joined, r.hits)}</span>`;
    b.onclick = () => { closeAll(); navigate(r.path.slice(0, -1)); openEntry(r.node); };
    li.appendChild(b);
    list.appendChild(li);
  });
  list._items = scored.slice(0, 12);
}

/* palette */
const COMMANDS = [
  { cat: "GET", label: "Download for Linux (AppImage)", run: () => window.open(DL.linux, "_blank") },
  { cat: "GET", label: "Download for Windows (MSI)", run: () => window.open(DL.win, "_blank") },
  { cat: "GET", label: "Download for macOS (dmg)", run: () => window.open(DL.mac, "_blank") },
  { cat: "VIEW", label: "Cycle Theme", run: toggleTheme },
  ...THEMES.map((t) => ({
    cat: "THEME",
    label: `Theme: ${t.label}`,
    run: () => applyTheme(t.id),
  })),
  { cat: "VIEW", label: "Show All Features", run: () => { navigate(["features"]); } },
  { cat: "VIEW", label: "Open Screenshots (Thumbnail Demo)", run: () => { navigate(["screenshots"]); } },
  { cat: "VIEW", label: "Toggle Sidebar", run: () => toggleBar("sidebar", "Sidebar") },
  { cat: "VIEW", label: "Toggle Status Bar", run: () => toggleBar("statusbar", "Status bar") },
  { cat: "VIEW", label: "Toggle Address Bar", run: () => toggleBar("toolbar", "Address bar") },
  { cat: "VIEW", label: "Toggle Title Bar", run: () => toggleBar("titlebar", "Title bar") },
  { cat: "VIEW", label: "Toggle Zen Mode (Hide All Bars)", run: zenMode },
  { cat: "GO", label: "View Source on GitHub", run: () => window.open(REPO, "_blank") },
  { cat: "GO", label: "View Changelog", run: () => window.open(`${REPO}/blob/main/CHANGELOG.md`, "_blank") },
  { cat: "GO", label: "Report a Bug", run: () => window.open(`${REPO}/issues/new`, "_blank") },
  { cat: "HELP", label: "Keyboard Shortcuts", run: () => { closeAll(); ks.open(); } },
];
let cpIndex = 0;
function cpRender() {
  const q = $("cp-input").value.trim();
  const list = $("cp-results");
  const scored = q
    ? COMMANDS.map((c) => { const m = fuzzy(q, c.label); return m && { ...c, ...m }; })
        .filter(Boolean).sort((a, b) => b.score - a.score)
    : COMMANDS.map((c) => ({ ...c, hits: [] }));
  cpIndex = Math.min(cpIndex, Math.max(0, scored.length - 1));
  list.innerHTML = "";
  if (!scored.length) {
    list.innerHTML = `<li class="nothing">No matching command.</li>`;
    return;
  }
  scored.forEach((c, i) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.className = i === cpIndex ? "active" : "";
    b.innerHTML = `<span class="cat">${c.cat}</span><span>${highlight(c.label, c.hits)}</span>`;
    b.onclick = () => { closeAll(); c.run(); };
    li.appendChild(b);
    list.appendChild(li);
  });
  list._items = scored;
}

function listNav(overlayObj, renderFn, getIndex, setIndex, event) {
  const list = overlayObj.el.querySelector("ul");
  const items = list._items || [];
  if (event.key === "ArrowDown") { setIndex(Math.min(getIndex() + 1, items.length - 1)); renderFn(); event.preventDefault(); }
  else if (event.key === "ArrowUp") { setIndex(Math.max(getIndex() - 1, 0)); renderFn(); event.preventDefault(); }
  else if (event.key === "Enter") {
    const chosen = items[getIndex()];
    if (!chosen) return;
    closeAll();
    if (chosen.run) chosen.run();
    else { navigate(chosen.path.slice(0, -1)); openEntry(chosen.node); }
    event.preventDefault();
  }
}


/* ── Toasts: transient guidance, like the app's notifications ── */

function toast(html, opts = {}) {
  const host = $("toasts");
  const t = document.createElement("div");
  t.className = "toast";
  const msg = document.createElement("span");
  msg.innerHTML = html;
  t.appendChild(msg);
  const dismiss = () => {
    if (!t.parentNode) return;
    t.classList.add("bye");
    setTimeout(() => t.remove(), 200);
  };
  if (opts.action) {
    const b = document.createElement("button");
    b.className = "toast-act";
    b.textContent = opts.action.label;
    b.onclick = () => { dismiss(); opts.action.run(); };
    t.appendChild(b);
  }
  host.appendChild(t);
  while (host.children.length > 3) host.firstChild.remove();
  setTimeout(dismiss, opts.ms || 4600);
}

/** A toast that fires once ever (per browser), for the guided nudges. */
function toastOnce(key, html, opts) {
  if (localStorage.getItem("toast." + key)) return;
  localStorage.setItem("toast." + key, "1");
  toast(html, opts);
}

/* ── Chrome toggles: every bar hides, like the real app ──── */

const BARS = [
  { id: "titlebar", label: "Title bar" },
  { id: "toolbar", label: "Address bar" },
  { id: "sidebar", label: "Sidebar" },
  { id: "statusbar", label: "Status bar" },
];
let hiddenBars = new Set();
try { hiddenBars = new Set(JSON.parse(localStorage.getItem("hiddenBars") || "[]")); } catch { /* corrupt state: start visible */ }

function applyChrome() {
  for (const b of BARS) $("window").toggleAttribute(`data-hide-${b.id}`, hiddenBars.has(b.id));
  localStorage.setItem("hiddenBars", JSON.stringify([...hiddenBars]));
}

function toggleBar(id, label) {
  const hiding = !hiddenBars.has(id);
  if (hiding) hiddenBars.add(id); else hiddenBars.delete(id);
  applyChrome();
  if (hiding) {
    toast(`${label} hidden — in the app, every bar toggles like this and the choice sticks per window.`,
      { action: { label: "Undo", run: () => toggleBar(id, label) } });
  } else {
    toast(`${label} back.`, { ms: 1800 });
  }
}

function zenMode() {
  const allHidden = BARS.every((b) => hiddenBars.has(b.id));
  hiddenBars = allHidden ? new Set() : new Set(BARS.map((b) => b.id));
  applyChrome();
  if (allHidden) {
    toast("Welcome back. The real app strips down the same way — and remembers.", { ms: 3600 });
  } else {
    toast(`Zen mode: just files. <kbd>Esc</kbd> brings the chrome back — <kbd>Ctrl+Shift+P</kbd> still works.`,
      { ms: 8000, action: { label: "Undo", run: zenMode } });
  }
}

/* ── Theme menu (toolbar button — the site-only extra) ───── */

function renderThemeMenu() {
  const menu = document.getElementById("theme-menu");
  if (!menu) return;
  const current = document.documentElement.getAttribute("data-theme");
  menu.innerHTML = "";
  for (const t of THEMES) {
    const b = document.createElement("button");
    b.className = "theme-item" + (t.id === current ? " active" : "");
    b.setAttribute("role", "menuitem");
    b.innerHTML = `<span class="swatch" data-swatch="${t.id}"></span>${t.label}` +
      (t.id === current ? `<span class="check">✓</span>` : "");
    b.onclick = () => { setThemeMenu(false); applyTheme(t.id, { announce: true }); };
    menu.appendChild(b);
  }
}

function setThemeMenu(open) {
  $("theme-menu").hidden = !open;
  $("theme-btn").classList.toggle("open", open);
  if (open) renderThemeMenu();
}

/* ── Tabs (decorative but honest: one is this site) ─────── */

function renderTabs() {
  const strip = $("tabstrip");
  strip.innerHTML = "";
  const tabs = [
    { label: "tauri-explorer", active: true, ico: SVG.app },
    { label: "Graph: this repo", href: `${REPO}/network`, ico: SVG.branch },
    { label: "+", href: `${REPO}/releases/latest`, title: "New tab (get the real app)" },
  ];
  for (const t of tabs) {
    const b = document.createElement("button");
    b.className = "tab" + (t.active ? " active" : "");
    b.innerHTML = (t.ico ? `<span class="ico">${t.ico}</span>` : "") + t.label;
    if (t.title) b.title = t.title;
    if (t.href) b.onclick = () => window.open(t.href, "_blank");
    strip.appendChild(b);
  }
}

/* ── Global keys ────────────────────────────────────────── */

document.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.shiftKey && e.key.toLowerCase() === "p") { e.preventDefault(); closeAll(); cp.open(); cpIndex = 0; return; }
  if (mod && !e.shiftKey && e.key.toLowerCase() === "p") { e.preventDefault(); closeAll(); qo.open(); qoIndex = 0; return; }
  if (mod && e.key === "/") { e.preventDefault(); closeAll(); ks.open(); return; }
  if (mod && !e.shiftKey && e.key.toLowerCase() === "t") { e.preventDefault(); toggleTheme(); return; }
  if (e.key === "Escape") {
    if (!$("theme-menu").hidden) { setThemeMenu(false); return; }
    if (qo.isOpen || cp.isOpen || ks.isOpen) { closeAll(); return; }
    // full zen: Esc is the panic button — chrome first, preview second
    if (BARS.every((b) => hiddenBars.has(b.id))) { zenMode(); return; }
    if (!$("preview").hidden) { $("preview").hidden = true; selectedName = null; render(); }
    return;
  }
  if (qo.isOpen) { listNav(qo, qoRender, () => qoIndex, (v) => (qoIndex = v), e); return; }
  if (cp.isOpen) { listNav(cp, cpRender, () => cpIndex, (v) => (cpIndex = v), e); return; }

  // list navigation when nothing is open
  if (e.key === "Backspace" && cwd.length) { e.preventDefault(); navigate(cwd.slice(0, -1)); return; }
  if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Enter"].includes(e.key)) {
    const rows = [...document.querySelectorAll(".row, .tile")];
    if (!rows.length) return;
    const idx = rows.findIndex((r) => r.dataset.name === selectedName);
    if (e.key === "Enter" && idx >= 0) { rows[idx].click(); e.preventDefault(); return; }
    const fwd = e.key === "ArrowDown" || e.key === "ArrowRight";
    const next = fwd ? Math.min(idx + 1, rows.length - 1) : Math.max(idx - 1, 0);
    const target = rows[next < 0 ? 0 : next];
    selectedName = target.dataset.name;
    rows.forEach((r) => r.classList.toggle("selected", r === target));
    target.scrollIntoView({ block: "nearest" });
    e.preventDefault();
  }
});

$("qo-input").addEventListener("input", () => { qoIndex = 0; qoRender(); });
$("cp-input").addEventListener("input", () => { cpIndex = 0; cpRender(); });
document.querySelectorAll(".overlay").forEach((ov) =>
  ov.addEventListener("click", (e) => { if (e.target === ov) closeAll(); }));

$("preview-close").onclick = () => { $("preview").hidden = true; selectedName = null; render(); };
$("nav-up").onclick = () => cwd.length && navigate(cwd.slice(0, -1));
$("nav-back").onclick = () => { const prev = history.pop(); if (prev) { cwd = prev; selectedName = null; render(); } };

/* theme menu: button toggles, clicking anywhere else closes */
$("theme-btn").onclick = () => setThemeMenu($("theme-menu").hidden);
document.addEventListener("click", (e) => {
  if (!e.target.closest(".theme-wrap")) setThemeMenu(false);
});

/* first-run hint (dismiss persists, like the app) */
if (localStorage.getItem("hintDismissed") !== "1") $("hint").hidden = false;
$("hint-dismiss").onclick = () => { localStorage.setItem("hintDismissed", "1"); $("hint").hidden = true; };

/* boot: land on README, preview open — the pitch reads itself */
renderTabs();
applyChrome();
renderThemeMenu();
render();
openEntry(FS.children[0]);

/* guided nudges, staggered so they read as a tour (each fires once ever) */
setTimeout(() => toastOnce("tour-zen",
  `Try <kbd>Ctrl+Shift+P</kbd> → <em>"Toggle Zen Mode"</em> — every bar on this page really hides.`,
  { ms: 8000 }), 9000);
setTimeout(() => toastOnce("tour-theme",
  "The palette icon in the toolbar restyles this whole page — the app themes the same way.",
  { ms: 8000 }), 24000);

/* prefetch every screenshot once the browser is idle — after that,
   opening any feature file or the gallery feels local */
(window.requestIdleCallback || ((f) => setTimeout(f, 1200)))(() => {
  const srcs = new Set();
  (function collect(node) {
    if (node.thumb) srcs.add(node.thumb);
    for (const m of (node.content || "").matchAll(/img\/[\w.-]+/g)) srcs.add(m[0]);
    (node.children || []).forEach(collect);
  })(FS);
  for (const src of srcs) { const im = new Image(); im.decoding = "async"; im.src = src; }
});
