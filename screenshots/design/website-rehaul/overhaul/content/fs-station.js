/* Fictional filesystem: Hollin Marsh Field Station, autumn 2026.
 * Consumed by the overhaul mock engine as window.TX_FS.station.
 * "Today" in the fiction is 2026-10-18 (a Sunday).
 */
(function () {
  "use strict";
  var TX = (window.TX_FS = window.TX_FS || {});

  /* ---------------- helpers ---------------- */
  var ASSETS = "../peel-mock/assets/";
  function body(s) { return s.replace(/^\n/, "").replace(/\n$/, ""); }
  function bytes(t) {
    var n = t.length;
    if (n < 1024) return n + " B";
    return (n / 1024).toFixed(1) + " KB";
  }
  function D(name, date, kids) { return { name: name, kind: "dir", date: date, kids: kids }; }
  function T(name, date, text, size) {
    var t = body(text);
    return { name: name, kind: "file", date: date, text: t, size: size || bytes(t) };
  }
  function B(name, date, size) { return { name: name, kind: "file", date: date, size: size }; }
  function IMG(name, date, file, px, size) {
    return { name: name, kind: "file", date: date, src: ASSETS + file, px: px, size: size };
  }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function hm(min) { min = ((min % 1440) + 1440) % 1440; return pad(Math.floor(min / 60)) + ":" + pad(min % 60); }
  function oct(d) { return "2026-10-" + pad(d); }
  function flac(name, date, minutes) {
    var mb = minutes * 17;
    return B(name, date, mb >= 1000 ? (mb / 1024).toFixed(1) + " GB" : mb + " MB");
  }

  /* ---------------- the count (single source of truth) ---------------- */
  // day, north pool, south scrape, reedbed roost, weather, extra notes by site
  var DAYS = [
    [1, 10, 58, 96, "clear; light NW", {}],
    [2, 11, 61, 99, "cloud; calm", {}],
    [3, 12, 64, 104, "drizzle", {}],
    [4, 12, 66, 108, "bright; W 3", {}],
    [5, 13, 69, 111, "overcast", {}],
    [6, 13, 71, 115, "showers", {}],
    [7, 14, 73, 117, "fog until 08:00", {}],
    [8, 14, 76, 120, "clear; cold", {}],
    [9, 14, 77, 123, "SW 6 rising; storm forecast", {}],
    [10, 13, 77, 123, "NW 7 easing; spray", { n: "north hide roof down; counted from dyke; K17 not read" }],
    [11, 13, 77, 123, "NW 4; clearing", { n: "from dyke; poor light" }],
    [12, 17, 77, 124, "calm; cold", { n: "from dyke" }],
    [13, 21, 76, 125, "fog", { n: "from dyke; fog; counted twice" }],
    [14, 24, 75, 126, "bright", { n: "from dyke" }],
    [15, 27, 74, 127, "W 3", { n: "hide back in use (patched)" }],
    [16, 29, 74, 128, "rain", {}],
    [17, 31, 73, 129, "clear", {}],
    [18, 30, 74, 130, "calm; first frost", {}]
  ];
  var SITE_KEY = { "north pool": "n", "south scrape": "s", "reedbed roost": "r" };
  // ring resightings this season (the reverted 11 Oct row is NOT here; see repo history)
  var RES = [
    ["2026-10-01", "07:41", "K17", "north pool"],
    ["2026-10-01", "07:40", "M03", "reedbed roost"],
    ["2026-10-02", "07:21", "P05", "south scrape"],
    ["2026-10-03", "07:25", "K09", "south scrape"],
    ["2026-10-04", "07:44", "K17", "north pool"],
    ["2026-10-06", "07:20", "M11", "south scrape"],
    ["2026-10-07", "07:46", "K17", "north pool"],
    ["2026-10-08", "07:31", "P02", "south scrape"],
    ["2026-10-09", "16:55", "K17", "north pool"],
    ["2026-10-12", "07:38", "M03", "reedbed roost"],
    ["2026-10-14", "07:38", "K09", "south scrape"],
    ["2026-10-15", "08:03", "P05", "north pool"],
    ["2026-10-17", "08:06", "M11", "north pool"]
  ];
  var K17_MAYBE = ["2026-10-11", "05:41", "K17", "north pool", "TR", "call + photo; ring not read"];
  var CODES = ["K09", "K12", "K17", "K21", "K22", "M03", "M07", "M11", "P02", "P05"];
  var PRIOR = { K09: "2025-10-19", K12: "2025-10-20", K17: "2025-10-22", K21: "2024-10-30", K22: "2025-10-11", M03: "2025-10-17", M07: "2025-10-18", M11: "2025-10-21", P02: "2025-10-25", P05: "2025-10-24" };

  function partial(d) { return d >= 10 && d <= 14; }
  function seasonCsv(upTo, k17north) {
    var out = ["date,north_pool,south_scrape,reedbed_roost,total,coverage,observer"];
    DAYS.forEach(function (r) {
      if (r[0] > upTo) return;
      var n = r[1] + (k17north && r[0] === 11 ? 1 : 0);
      out.push([oct(r[0]), n, r[2], r[3], n + r[2] + r[3], partial(r[0]) ? "partial" : "full", "IO"].join(","));
    });
    return out.join("\n");
  }
  function resCsv(upTo, withMaybe) {
    var out = ["date,time,code,site,observer,method"];
    var rows = RES.filter(function (x) { return x[0] <= upTo; }).map(function (x) {
      return [x[0], x[1], x[2], x[3], "IO", x[2] === "K17" && x[1] === "16:55" ? "ring read (scope; evening check)" : "ring read (scope)"];
    });
    if (withMaybe) rows.push(K17_MAYBE);
    rows.sort(function (a, b) { return (a[0] + a[1]).localeCompare(b[0] + b[1]); });
    rows.forEach(function (r) { out.push(r.join(",")); });
    return out.join("\n");
  }
  function statusCsv(upTo, k17state) {
    var out = ["code,status,last_seen"];
    CODES.forEach(function (c) {
      var seen = RES.filter(function (x) { return x[2] === c && x[0] <= upTo; }).map(function (x) { return x[0]; }).sort();
      var status = seen.length ? "present" : "not seen";
      var last = seen.length ? seen[seen.length - 1] : PRIOR[c];
      if (c === "K17" && k17state === "missing") status = "missing";
      if (c === "K17" && k17state === "maybe") { status = "present"; last = "2026-10-11"; }
      out.push([c, status, last].join(","));
    });
    return out.join("\n");
  }
  function dailyCsv(r) {
    var d = r[0], i = d - 1;
    var notes = { n: [], s: [], r: [] };
    RES.forEach(function (x) {
      if (x[0] === oct(d)) notes[SITE_KEY[x[3]]].push(x[2] + " read " + x[1] + (x[1] === "16:55" ? " (evening check)" : ""));
    });
    ["n", "s", "r"].forEach(function (k) { if (r[5][k]) notes[k].push(r[5][k]); });
    var lines = [
      "time,site,count,method,note",
      hm(400 + 2 * i) + ",reedbed roost," + r[3] + ",flight-out tally," + [r[4]].concat(notes.r).join("; "),
      hm(425 + 2 * i) + ",south scrape," + r[2] + ",scope; higher of 2 scans," + notes.s.join("; "),
      hm(450 + 2 * i) + ",north pool," + r[1] + "," + (partial(d) ? "scope from dyke" : "scope from north hide") + "," + notes.n.join("; "),
      ",total," + (r[1] + r[2] + r[3]) + ",,"
    ];
    return lines.join("\n");
  }

  /* ---------------- unified diff (LCS) ---------------- */
  function udiff(path, a, b) {
    var A = a || [], Bv = b || [], n = A.length, m = Bv.length, i, j;
    var L = [];
    for (i = 0; i <= n; i++) { L.push(new Array(m + 1).fill(0)); }
    for (i = n - 1; i >= 0; i--) for (j = m - 1; j >= 0; j--) L[i][j] = A[i] === Bv[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    var ops = []; i = 0; j = 0;
    while (i < n && j < m) {
      if (A[i] === Bv[j]) { ops.push([" ", A[i], i, j]); i++; j++; }
      else if (L[i + 1][j] >= L[i][j + 1]) { ops.push(["-", A[i], i, j]); i++; }
      else { ops.push(["+", Bv[j], i, j]); j++; }
    }
    while (i < n) { ops.push(["-", A[i], i, j]); i++; }
    while (j < m) { ops.push(["+", Bv[j], i, j]); j++; }
    var changed = [];
    ops.forEach(function (o, k) { if (o[0] !== " ") changed.push(k); });
    if (!changed.length) return "";
    var C = 3, groups = [], s = Math.max(0, changed[0] - C), e = Math.min(ops.length - 1, changed[0] + C);
    changed.slice(1).forEach(function (k) {
      if (k - C <= e + 1) e = Math.min(ops.length - 1, k + C);
      else { groups.push([s, e]); s = Math.max(0, k - C); e = Math.min(ops.length - 1, k + C); }
    });
    groups.push([s, e]);
    var out = ["--- " + (a ? "a/" + path : "/dev/null"), "+++ " + (b ? "b/" + path : "/dev/null")];
    groups.forEach(function (g) {
      var seg = ops.slice(g[0], g[1] + 1);
      var oc = seg.filter(function (o) { return o[0] !== "+"; }).length;
      var nc = seg.filter(function (o) { return o[0] !== "-"; }).length;
      var os = oc ? seg[0][2] + 1 : seg[0][2];
      var ns = nc ? seg[0][3] + 1 : seg[0][3];
      out.push("@@ -" + os + "," + oc + " +" + ns + "," + nc + " @@");
      seg.forEach(function (o) { out.push(o[0] + o[1]); });
    });
    return out.join("\n");
  }

  /* ---------------- Ines's repo, built commit by commit ---------------- */
  function readme(o) {
    return body(`
# crane-counts

Dawn counts and ring resightings for Hollin Marsh, autumn 2026.

## Sites
- reedbed roost: flight-out tally from the south hide, first light
- south scrape: two scope scans 20 minutes apart; the higher one counts
- north pool: ` + (o.dyke ? "scope scan from the north hide (from the dyke while the hide is shut)" : "scope scan from the north hide") + `

## Layout
- counts/2026-autumn.csv: one row per dawn count. total must equal the sum of the three sites; tally.py refuses otherwise.
- rings/register.csv: every bird ringed here since 2023.
- rings/resightings-2026.csv: one row per ring read this season.
- rings/status-2026.csv: one row per ring, current status.
- scripts/: tally.py (checks and summaries), plot_sites.R (site trends).

## Status values
- present: ring read this season
- not seen: not read this season
- missing: read this season, then not read after a known event (storm, disturbance)
` + (o.unconfirmed ? "- unconfirmed: reported by call, sighting or photo without a ring read. Kept in resightings with the method stated. Never counted.\n" : "") + `
## Rules
` + (o.unconfirmed
      ? "- A ring is read or it is not. No ring read, no count. But a report is still a record: mark it unconfirmed, do not revert it."
      : "- A ring is read or it is not. No ring read, no record. (Rule 4 in the methods notebook.)") + `
- A record that turns out to be wrong is reverted, not edited, so the history shows it.
- make export copies the counts to /srv/station/counts-latest.csv for the others. Run it after every count.
`);
  }
  function tallyPy(o) {
    return body(`
#!/usr/bin/env python3
"""Check and summarise the Hollin Marsh dawn counts.

Usage: tally.py [--since YYYY-MM-DD]
"""
import csv
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
COUNTS = ROOT / "counts" / "2026-autumn.csv"
STATUS = ROOT / "rings" / "status-2026.csv"
SITES = ("north_pool", "south_scrape", "reedbed_roost")
STATUSES = {"present", "not seen", "missing"` + (o.unconfirmed ? `, "unconfirmed"` : "") + `}
COVERAGE = {"full"` + (o.partial ? `, "partial"` : "") + `}
` + (o.rise ? "RISE = 0.5  # flag a site that rises by more than half across five counts\n" : "") + `

def load(path):
    with open(path, newline="") as f:
        return list(csv.DictReader(f))


def check(rows):
    for r in rows:
        total = sum(int(r[s]) for s in SITES)
        if total != int(r["total"]):
            sys.exit(f"{r['date']}: sites sum to {total}, total says {r['total']}")
        if r["coverage"] not in COVERAGE:
            sys.exit(f"{r['date']}: unknown coverage {r['coverage']!r}")
` + (o.rise ? `

def rises(rows, site, window=5):
    out = []
    for a, b in zip(rows, rows[window:]):
        lo, hi = int(a[site]), int(b[site])
        if lo and (hi - lo) / lo > RISE:
            out.append((a["date"], b["date"], lo, hi))
    return out
` : "") + `

def main(argv):
    since = argv[argv.index("--since") + 1] if "--since" in argv else ""
    rows = [r for r in load(COUNTS) if r["date"] >= since]
    check(rows)
    for r in rows:
        sites = "  ".join(f"{r[s]:>4}" for s in SITES)
        print(f"{r['date']}  {r['total']:>4}  {sites}  {r['coverage']}")
` + (o.rise ? `    for site in SITES:
        for a, b, lo, hi in rises(rows, site):
            print(f"rise: {site} {lo} -> {hi} between {a} and {b}")
` : "") + `    for s in load(STATUS):
        if s["status"] not in STATUSES:
            sys.exit(f"{s['code']}: unknown status {s['status']!r}")


if __name__ == "__main__":
    main(sys.argv[1:])
`);
  }
  var MAKEFILE = body(`
COUNTS = counts/2026-autumn.csv
SHARED = /srv/station/counts-latest.csv

.PHONY: tally plot export

tally:
\tpython3 scripts/tally.py

plot:
\tRscript scripts/plot_sites.R

export: tally
\tcp $(COUNTS) $(SHARED)
\t@echo "exported to $(SHARED)"
`);
  var PLOT_R = body(`
# North pool against everything else, autumn 2026.
# Started 14 Oct because the north pool keeps going up and I want to see it, not read it.
library(ggplot2)

counts <- read.csv("counts/2026-autumn.csv")
counts$date <- as.Date(counts$date)
counts$rest <- counts$total - counts$north_pool

long <- rbind(
  data.frame(date = counts$date, site = "north pool", n = counts$north_pool),
  data.frame(date = counts$date, site = "everything else / 10", n = counts$rest / 10)
)

p <- ggplot(long, aes(date, n, colour = site)) +
  geom_line() + geom_point() +
  geom_vline(xintercept = as.Date("2026-10-09"), linetype = "dashed") +
  annotate("text", x = as.Date("2026-10-09"), y = 35, label = "storm", hjust = -0.1) +
  labs(x = NULL, y = "cranes", colour = NULL) +
  theme_minimal()

ggsave("north-pool.png", p, width = 7, height = 4)
`);
  var REGISTER = body(`
ring_code,metal_ring,colour_ring_left,ringed,age,site,ringer,mass_g,notes
K09,HM-23-0109,green K09,2023-10-04,juvenile,north pool,IO,4120,
K12,HM-23-0112,green K12,2023-10-04,adult,north pool,IO,5310,
K17,HM-23-0117,green K17,2023-10-04,juvenile,north pool,IO,3980,grey on the nape (unusual for age; kept as adult in 2024 and 2025)
K21,HM-23-0121,green K21,2023-10-05,juvenile,south scrape,IO,4050,
K22,HM-23-0122,green K22,2023-10-05,adult,south scrape,IO,5480,slight limp; old injury
M03,HM-24-0203,blue M03,2024-10-08,juvenile,reedbed roost,IO,4210,
M07,HM-24-0207,blue M07,2024-10-08,adult,reedbed roost,IO,5540,
M11,HM-24-0211,blue M11,2024-10-09,juvenile,south scrape,IO,3890,
P02,HM-25-0302,yellow P02,2025-10-06,juvenile,north pool,IO,4005,
P05,HM-25-0305,yellow P05,2025-10-06,juvenile,north pool,IO,4180,TR holding; TR bitten
`);
  var GITIGNORE = "north-pool.png\n__pycache__/\n.Rhistory";

  var AUTHOR = "Ines Okafor";
  var repoState = {}, lastTouched = {}, commits = [];
  function commit(hash, parents, date, msg, changes, refs) {
    var files = [];
    Object.keys(changes).forEach(function (path) {
      var content = changes[path];
      if (content === "MERGED") { files.push({ path: path, status: "A" }); return; }
      var before = repoState[path] != null ? repoState[path].split("\n") : null;
      var after = content == null ? null : content.split("\n");
      var f = { path: path, status: !before ? "A" : !after ? "D" : "M", diff: udiff(path, before, after) };
      files.push(f);
      if (after) repoState[path] = content; else delete repoState[path];
      lastTouched[path] = date.slice(0, 10);
    });
    var c = { hash: hash, msg: msg, author: AUTHOR, date: date, files: files };
    if (parents.length) c.parents = parents;
    if (refs) c.refs = refs;
    commits.unshift(c); // newest first, like git log
  }

  var H = {
    init: "1a7c3e0", reg: "4be19d2", partial: "8d0f5a1", c13: "c21e7b9", c46: "0f93d44", c79: "b7a2c18",
    storm: "e54d901", c11: "3c6f2ab", k17: "5e0b7c1", revert: "9a4d2f8", plot: "d18b6e3",
    c1215: "72c4fa0", merge: "a93e5d7", c1617: "6f1b0c2", c18: "2d8e47a", unconf: "f40a9b6"
  };
  commit(H.init, [], "2026-08-28T19:40:00", "Initial commit: season skeleton", {
    "README.md": readme({}), "counts/2026-autumn.csv": seasonCsv(0), "scripts/tally.py": tallyPy({}), ".gitignore": GITIGNORE
  });
  commit(H.reg, [H.init], "2026-09-02T21:15:00", "Add ring register, 2023-2025 (typed up from the field sheets)", {
    "rings/register.csv": REGISTER
  });
  commit(H.partial, [H.reg], "2026-09-15T20:02:00", "tally: accept partial-coverage days; add Makefile with export target", {
    "scripts/tally.py": tallyPy({ partial: true }), "Makefile": MAKEFILE
  });
  commit(H.c13, [H.partial], "2026-10-03T08:10:00", "Counts 1-3 Oct; K17 back on the north pool (1 Oct)", {
    "counts/2026-autumn.csv": seasonCsv(3), "rings/resightings-2026.csv": resCsv("2026-10-03"), "rings/status-2026.csv": statusCsv("2026-10-03")
  });
  commit(H.c46, [H.c13], "2026-10-06T08:05:00", "Counts 4-6 Oct", {
    "counts/2026-autumn.csv": seasonCsv(6), "rings/resightings-2026.csv": resCsv("2026-10-06"), "rings/status-2026.csv": statusCsv("2026-10-06")
  });
  commit(H.c79, [H.c46], "2026-10-09T08:20:00", "Counts 7-9 Oct", {
    "counts/2026-autumn.csv": seasonCsv(9), "rings/resightings-2026.csv": resCsv("2026-10-09"), "rings/status-2026.csv": statusCsv("2026-10-09")
  });
  commit(H.storm, [H.c79], "2026-10-10T09:30:00", "Count 10 Oct (storm); K17 missing\n\nNorth hide roof down on the seaward side. North pool counted from the dyke. K17 not read.", {
    "counts/2026-autumn.csv": seasonCsv(10), "rings/status-2026.csv": statusCsv("2026-10-10", "missing"), "README.md": readme({ dyke: true })
  });
  commit(H.c11, [H.storm], "2026-10-11T06:58:00", "Count 11 Oct", {
    "counts/2026-autumn.csv": seasonCsv(11)
  });
  var beforeK17 = {
    counts: repoState["counts/2026-autumn.csv"], res: repoState["rings/resightings-2026.csv"], status: repoState["rings/status-2026.csv"]
  };
  commit(H.k17, [H.c11], "2026-10-11T07:04:00", "K17 resighted 11 Oct, north pool 05:41 (TR: call + photo)", {
    "counts/2026-autumn.csv": seasonCsv(11, true), "rings/resightings-2026.csv": resCsv("2026-10-11", true), "rings/status-2026.csv": statusCsv("2026-10-11", "maybe")
  });
  var SHARED_EXPORT = repoState["counts/2026-autumn.csv"]; // what `make export` copied at 07:10
  commit(H.revert, [H.k17], "2026-10-11T21:48:00", "Revert \"K17 resighted 11 Oct, north pool 05:41 (TR: call + photo)\"\n\nThis reverts commit " + H.k17 + ".\n\nUnconfirmed - no ring read. TR: frame too soft to read; deleted. A call is not an ID (rule 4).", {
    "counts/2026-autumn.csv": beforeK17.counts, "rings/resightings-2026.csv": beforeK17.res, "rings/status-2026.csv": beforeK17.status
  });
  commit(H.plot, [H.revert], "2026-10-14T20:40:00", "plot_sites.R: north pool against everything else", {
    "scripts/plot_sites.R": PLOT_R
  }, ["explore/north-pool"]);
  commit(H.c1215, [H.revert], "2026-10-15T08:15:00", "Counts 12-15 Oct", {
    "counts/2026-autumn.csv": seasonCsv(15), "rings/resightings-2026.csv": resCsv("2026-10-15"), "rings/status-2026.csv": statusCsv("2026-10-15", "missing")
  });
  commit(H.merge, [H.c1215, H.plot], "2026-10-16T19:02:00", "Merge branch 'explore/north-pool'", {
    "scripts/plot_sites.R": "MERGED"
  });
  commit(H.c1617, [H.merge], "2026-10-17T08:30:00", "Counts 16-17 Oct; tally flags sustained site rises\n\nnorth_pool 13 -> 29 between 2026-10-11 and 2026-10-16.", {
    "counts/2026-autumn.csv": seasonCsv(17), "rings/resightings-2026.csv": resCsv("2026-10-17"), "rings/status-2026.csv": statusCsv("2026-10-17", "missing"), "scripts/tally.py": tallyPy({ partial: true, rise: true })
  });
  commit(H.c18, [H.c1617], "2026-10-18T08:12:00", "Count 18 Oct", {
    "counts/2026-autumn.csv": seasonCsv(18)
  });
  commit(H.unconf, [H.c18], "2026-10-18T11:30:00", "Add 'unconfirmed' status\n\nA call, a glimpse or a soft photo is still an observation. It should be kept with its method stated, not reverted. Should have existed on the 11th: see " + H.k17 + " and its revert " + H.revert + ".\n\nNot applied to K17. There is nothing left to apply it from.", {
    "README.md": readme({ dyke: true, unconfirmed: true }), "scripts/tally.py": tallyPy({ partial: true, rise: true, unconfirmed: true })
  }, ["HEAD -> main"]);

  function R(path, name) { return T(name || path.split("/").pop(), lastTouched[path], repoState[path]); }

  /* ---------------- settings.json per user ---------------- */
  var PART_IDS = ["tabs", "address", "sidebar", "miller", "peek", "terminal", "split", "preview", "plugin", "status"];
  function settings(setup, extra, note) {
    var parts = {};
    PART_IDS.forEach(function (k) { parts[k] = setup.parts.indexOf(k) >= 0; });
    var o = { colorTheme: setup.theme, layout: setup.layout, iconTheme: setup.icons, defaultView: setup.view, startPath: setup.path, parts: parts };
    Object.keys(extra).forEach(function (k) { o[k] = extra[k]; });
    o.note = note;
    return JSON.stringify(o, null, 2);
  }
  var SETUP = {
    ines: { parts: ["tabs", "address", "sidebar", "split", "terminal", "status"], theme: "nord", layout: "hairline-ledger", icons: "material", view: "details", path: "/home/ines/Projects/crane-counts" },
    tomas: { parts: ["tabs", "address", "sidebar", "preview"], theme: "solarized-light", layout: "floating-islands", icons: "catppuccin", view: "tiles", path: "/home/tomas/Pictures/2026-autumn" },
    wren: { parts: ["status"], theme: "light", layout: "default", icons: "minimal", view: "list", path: "/home/wren/journal" }
  };

  /* ---------------- generated logs and tables ---------------- */
  function kettleLog() {
    var out = [];
    for (var d = 5; d <= 18; d++) {
      var day = oct(d), j = (d * 7) % 11;
      if (d === 10) {
        out.push(day + " 04:31:" + pad(10 + j) + " boil 1.5 L");
      }
      if (d >= 11 && d <= 17) out.push(day + " 04:" + pad(48 + (d % 5)) + ":" + pad(20 + j) + " boil 0.5 L");
      out.push(day + " 06:" + pad(1 + (j % 6)) + ":" + pad(30 + j) + " boil 1.2 L");
      out.push(day + " 06:" + pad(28 + j) + ":0" + (j % 9) + " boil 0.6 L");
      if (d === 9) {
        out.push(day + " 15:12:44 boil 1.0 L");
        out.push(day + " 21:52:03 boil 1.4 L");
        out.push(day + " 23:12:40 power lost");
        continue;
      }
      out.push(day + " 15:" + pad(5 + j) + ":12 boil 1.0 L");
      out.push(day + " 21:" + pad(10 + 2 * j) + ":48 boil 0.8 L");
    }
    return out.join("\n");
  }
  function tideCsv() {
    var out = ["date,high_1,height_1_m,high_2,height_2_m,note"];
    var NOTES = {
      9: "springs + storm surge; water over the dyke path at 22:00",
      10: "debris on the dyke; north hide roof in the reeds",
      11: "low about 05:20; shelf by the old feeder post dry before light",
      15: "neaps from here; shelf stays dry longer",
      17: "neaps; shelf dry all morning",
      24: "boat day (if)"
    };
    for (var d = 1; d <= 31; d++) {
      var start = (d - 1) * 1440, highs = [];
      for (var k = 0; k < 70; k++) { var t = 192 + 745 * k; if (t >= start && t < start + 1440) highs.push(t); }
      var row = [oct(d)];
      for (var h = 0; h < 2; h++) {
        if (highs[h] == null) { row.push("-", "-"); continue; }
        var dayf = highs[h] / 1440;
        var ht = 4.3 + 0.9 * Math.cos(2 * Math.PI * (dayf - 8.9) / 14.77) + (h ? -0.1 : 0);
        if (d === 9 && h === 1) ht += 0.6;
        row.push(hm(highs[h] - start), ht.toFixed(1));
      }
      row.push(NOTES[d] || "");
      out.push(row.join(","));
    }
    return out.join("\n");
  }
  function generatorLog() {
    var out = [], fuel = 66;
    for (var d = 6; d <= 18; d++) {
      var day = oct(d);
      if (d === 10) {
        out.push("-- reboot --");
        out.push(day + " 04:19:02 gen: manual start (attempt 1) failed");
        out.push(day + " 04:20:17 gen: manual start (attempt 2)");
        out.push(day + " 04:20:30 gen: running, load 0.3 kW, fuel " + fuel + "%");
        out.push(day + " 04:21:02 gen: operator note: filter element replaced; water in bowl");
      }
      out.push(day + " 06:00:00 gen: running, load " + (0.6 + (d % 3) / 10).toFixed(1) + " kW, fuel " + fuel + "%");
      if (d === 9) {
        out.push(day + " 21:30:10 gen: running, load 1.9 kW, fuel " + fuel + "%");
        out.push(day + " 22:47:33 gen: WARN fuel pressure low");
        out.push(day + " 22:51:08 gen: WARN fuel pressure low");
        out.push(day + " 23:04:56 gen: WARN fuel pressure low");
        out.push(day + " 23:12:40 gen: FAULT fuel starvation; engine stopped");
        out.push(day + " 23:12:41 ups: on battery, est. 46 min");
        out.push(day + " 23:58:02 ups: battery exhausted; shutting down hollin-marsh");
        continue;
      }
      out.push(day + " 18:00:00 gen: running, load " + (1.1 + (d % 4) / 10).toFixed(1) + " kW, fuel " + (fuel - 1) + "%");
      fuel -= 2;
      if (d === 12) { out.push(day + " 10:30:00 gen: refuelled (+180 L)"); fuel += 44; }
    }
    return out.join("\n");
  }

  /* ---------------- / ---------------- */
  var etc = D("etc", "2026-10-15", [
    T("motd", "2026-10-15", `
  Hollin Marsh Field Station  .  hollin-marsh

  Shared machine. Three homes, one /srv/station. Be kind to the disk.

  - The generator runs day and night in the season. If the lights dim, it is not you.
  - Grey drive marked BACKUP: plug it in on Sundays.
    The other grey drive is a doorstop.
  - North hide: roof patched 15 Oct. Felt on the next boat.
  - Nothing wet on the keyboard. That includes gloves, tea,
    and microphones in socks.

  Last login from the kitchen. All logins are from the kitchen.
`),
    T("hostname", "2023-08-30", "hollin-marsh"),
    T("timezone", "2023-08-30", "Etc/UTC"),
    T("hosts", "2025-03-14", `
127.0.0.1   localhost
127.0.1.1   hollin-marsh
10.0.0.1    router     # in the cupboard with the brooms
10.0.0.7    printer    # "out of paper"
10.0.0.9    kettle     # yes
`),
    T("fstab", "2025-03-14", `
# /etc/fstab: static file system information
UUID=3f2a9c1e-7b40-4d1a-9e55-0c8b2d61a7f4  /       ext4  defaults,noatime  0 1
UUID=8c11d0b2-52fa-4e0c-a3b9-61f0e2d7c9aa  /home   ext4  defaults,noatime  0 2
# grey drive marked BACKUP. Sundays. (not the doorstop)
LABEL=BACKUP   /media/backup   ext4   noauto,user,nofail   0 0
`)
  ]);

  var usr = D("usr", "2026-08-28", [
    D("bin", "2026-09-30", [
      B("tauri-explorer", "2026-09-30", "14.2 MB"),
      B("git", "2026-08-28", "3.9 MB"),
      B("python3", "2026-08-28", "6.1 MB"),
      B("Rscript", "2026-08-28", "18 KB"),
      B("sox", "2026-09-30", "412 KB")
    ])
  ]);

  var varDir = D("var", "2026-10-18", [
    D("log", "2026-10-18", [
      T("generator.log", "2026-10-18", generatorLog()),
      T("kettle.log", "2026-10-18", kettleLog()),
      T("printer.log", "2026-10-17", `
2025-03-02 10:14:07 paper loaded (500 sheets)
2025-03-02 10:14:09 out of paper
2025-03-02 10:20:31 paper loaded (500 sheets)
2025-03-02 10:20:33 out of paper
2025-03-02 10:21:00 job "spring-count-sheet.pdf" (ines) held: out of paper
2025-03-02 10:26:47 paper loaded (499 sheets)
2025-03-02 10:26:48 out of paper
2025-09-14 08:02:11 job "methods-2025.pdf" (ines) held: out of paper
2026-09-30 17:40:05 job "gear-list.md" (tomas) held: out of paper
2026-10-10 06:12:44 job "counts-2026-10-10.csv" (ines) held: out of paper
2026-10-15 19:30:02 job "quiz-2026-answers.md" (tomas) held: out of paper
2026-10-17 18:02:13 job "tin-curry.md" (wren) printed (1 page)
2026-10-17 18:02:15 out of paper
`)
    ])
  ]);

  /* ---------------- /home/ines ---------------- */
  var ines = D("ines", "2026-10-18", [
    D(".config", "2026-09-01", [
      D("tauri-explorer", "2026-10-12", [
        T("settings.json", "2026-10-12", settings(SETUP.ines, { showHiddenFiles: true, splitPanes: ["/home/ines/Projects/crane-counts", "/srv/station"] },
          "Two panes: the repo on the left, the shared folder on the right, so I can see what the others see. Terminal because the mouse is slower than I am. Status bar for the branch, so I never commit counts to the wrong one twice. Details view because a file without a date and a size is a rumour."))
      ])
    ]),
    T(".bashrc", "2026-08-28", `
# ~/.bashrc (ines)
export EDITOR=vim
alias ll='ls -lh'
alias count='cd ~/Projects/crane-counts && make tally'
alias tide='column -s, -t < /home/wren/tides-2026-10.csv | less'
# do not alias rm. you know why.
`),
    T(".gitconfig", "2026-08-28", `
[user]
	name = Ines Okafor
	email = ines@hollin-marsh.local
[core]
	editor = vim
[alias]
	lg = log --oneline --graph --all
	last = log -1 --stat
[pull]
	rebase = false
`),
    T(".bash_history", "2026-10-18", `
cd ~/Projects/crane-counts
make tally
git add counts
git commit -m "Count 10 Oct (storm); K17 missing"
make export
make tally
git commit -am "Count 11 Oct"
vim rings/resightings-2026.csv
vim rings/status-2026.csv
vim counts/2026-autumn.csv
git commit -am "K17 resighted 11 Oct, north pool 05:41 (TR: call + photo)"
make export
git lg
git show ${"5e0b7c1"} --stat
git revert ${"5e0b7c1"}
git lg
cat /var/log/kettle.log | tail -40
python3 scripts/tally.py --since 2026-10-09
git switch -c explore/north-pool
Rscript scripts/plot_sites.R
git add scripts/plot_sites.R
git commit -m "plot_sites.R: north pool against everything else"
git switch main
git merge explore/north-pool
python3 scripts/tally.py --since 2026-10-09
make tally
git commit -am "Count 18 Oct"
vim README.md
git log --oneline -- rings/status-2026.csv
git commit -am "Add 'unconfirmed' status"
`),
    D("Projects", "2026-08-28", [
      D("crane-counts", "2026-10-18", [
        D(".git", "2026-10-18", [
          T("HEAD", "2026-10-16", "ref: refs/heads/main"),
          T("config", "2026-08-28", `
[core]
	repositoryformatversion = 0
	filemode = true
	bare = false
[branch "main"]
	merge = refs/heads/main
`),
          T("ORIG_HEAD", "2026-10-16", H.c1215 + "8e1f02c94d7a5b3e6c0f1a2b9d84e7c35")
        ]),
        R(".gitignore"),
        R("README.md"),
        R("Makefile"),
        D("counts", lastTouched["counts/2026-autumn.csv"], [R("counts/2026-autumn.csv")]),
        D("rings", lastTouched["rings/status-2026.csv"], [
          R("rings/register.csv"), R("rings/resightings-2026.csv"), R("rings/status-2026.csv")
        ]),
        D("scripts", lastTouched["scripts/tally.py"], [R("scripts/tally.py"), R("scripts/plot_sites.R")])
      ])
    ]),
    D("Fieldwork", "2026-10-18", [
      T("methods-notebook.md", "2026-10-18", `
# Methods notebook, autumn 2026

## Rules
- Rule 1: Count from the same place at the same time. If the place changes, say so.
- Rule 2: Two scans at the scrape, 20 minutes apart. Keep the higher.
- Rule 3: Roost is a flight-out tally. One click per bird. Estimate only if more than 40 lift at once.
- Rule 4: No ring read, no record. A call is not an ID. A shape is not an ID. A feeling is definitely not an ID.
- Rule 5: Wrong records get reverted, not edited.
- Rule 6: Nobody feeds the birds. (Handbook rule 9. Repeated here because last year someone left toast on the hide sill.)

## Log
- 28 Aug. Arrived. Generator sulking. W already here, has been since spring. Repo set up.
- 2 Sep. Ring register typed up from the 2023-2025 field sheets. Ten birds. Four not seen since last year or before.
- 15 Sep. tally.py accepts partial coverage. I would rather it never had to.
- 30 Sep. TR arrived. Eleven bags.
- 1 Oct. First count: 164. K17 read 07:41, north pool. One day earlier than 2024, two days later than 2025. Seventeen is in.
- 4 Oct. 186. K17 again. Three years to the day since ringing.
- 7 Oct. 204. K17. Standing where it always stands.
- 9 Oct. 214. Evening check 16:55: K17 on the north pool shelf with eleven others. Storm forecast for tonight. Hide shutters closed.
- 10 Oct. 213. North hide roof gone, seaward side. North pool from the dyke: 13, poor light, spray. K17 not read. Status: missing.
- 11 Oct. 213. TR: one call, north pool, 05:40, before light. One frame. Added 07:04, exported. TR at lunch: frame too soft to read, deleted. Reverted 21:48. Rule 4.
- 12 Oct. 218. North pool 17.
- 13 Oct. 222. North pool 21. Kettle log shows someone boiling half a litre at ten to five every morning since the 11th. Not me. Not relevant.
- 14 Oct. 225. North pool 24. Started north-pool-cluster.md.
- 15 Oct. 228. Hide roof patched (W, TR). Full coverage again.
- 16 Oct. 231.
- 17 Oct. 233. North pool 31. tally.py flags it: north_pool 13 -> 29 between 2026-10-11 and 2026-10-16.
- 18 Oct. 234. Added unconfirmed as a status. Rule 4 stands for counting. But a report is still a record and I should not have taken it out. Have not re-added the 11th. There is nothing to re-add it from.
`),
      T("north-pool-cluster.md", "2026-10-17", `
# North pool cluster

Started 14 Oct. Updated 17 Oct.

## The numbers (dawn, north pool)
- 9 Oct: 14
- 10 Oct: 13 (from dyke)
- 11 Oct: 13 (from dyke)
- 12 Oct: 17
- 13 Oct: 21
- 14 Oct: 24
- 15 Oct: 27
- 16 Oct: 29
- 17 Oct: 31

The scrape is flat or falling. The total is rising at the usual rate. So it is not new arrivals. It is birds choosing the north pool.

## Things it is not
- Water level. Checked W's tide table: neaps from the 15th, so the shelf dries for longer. That helps a little. It does not get you from 13 to 31.
- Disturbance elsewhere. Scrape quiet. Nobody walking the south track.
- Food. The north pool is bare mud and a reed fringe. There is nothing there to eat. I have looked. Twice.
- The roof repair. Hammering on the 15th should have pushed them off. It did not.
- Me counting badly. TR's recordings from the 13th and 16th have more feeding sound from the shelf than anything this season, and TR does not count. TR just listens.

## Rings read at the north pool since the 11th
- P05, 15 Oct.
- M11, 17 Oct.
- Nobody else.

## Things it could be
- Shelter after the storm. Possible. The storm was a week ago.
- One bird the others follow. Cranes do. That would need a bird that knows the place.
- Something I am not seeing.

## Note to self
- Do not want this to be something. Count it.
`),
      D("daily", "2026-10-18", DAYS.map(function (r) { return T(oct(r[0]) + ".csv", oct(r[0]), dailyCsv(r)); }))
    ]),
    D("Grants", "2026-10-16", [
      T("2027-renewal-draft.md", "2026-10-16", `
# Renewal application, 2027-2029 (draft 3)

## Summary
- Hollin Marsh has counted cranes at dawn every autumn since 2023, from the same three places, at the same times, by the same method.
- We ask for three more seasons: fuel, food, boats, rings, and one hide roof.

## Why continuity matters
- A count is only useful next to the count before it. Four seasons is the start of a series, not a series.
- Ringing lets us follow individuals. Ten birds ringed here since 2023; six read so far this season.
- One bird ringed here as a juvenile in 2023 returned in 2024, 2025 and 2026, within three days of the same date each year, to the same pool. That is the kind of fact only a long series produces, and the kind that disappears when funding gaps do.

## What changed this year
- The storm of 9 October 2026 took half the north hide roof. A temporary patch holds. The budget includes a proper one.
- North pool numbers rose from 13 to 31 in the week after the storm, against a flat scrape. We do not yet know why. A further three seasons is how we would find out.

## Budget
- See budget-2027.csv. Diesel is most of it. It is always most of it.

## Notes to self (delete before sending)
- The K17 paragraph. Status is missing, not gone. Leave it in.
- Ask W for the food figure. W knows exactly how long a sack lasts.
- Ask TR for one photograph for the cover. Not a bird in hand. A bird on the marsh.
`),
      (function () {
        var rows = [
          ["Colour rings (2027 series)", 40, 6, "R-series; red"],
          ["Metal rings", 40, 2, ""],
          ["Diesel (litres)", 3300, 1.6, "generator; about 9 L a day"],
          ["Fuel filter elements", 6, 28, "it is always the fuel filter"],
          ["North hide roof (felt; battens; labour)", 1, 1400, "storm damage 9 Oct 2026"],
          ["Food (person-days)", 360, 9, "3 people x 120 days; ask W"],
          ["Boat (Thursdays)", 36, 85, "weather permitting"],
          ["Recorder batteries (AA)", 96, 3, "TR says 96"],
          ["Backup drive (a second one that works)", 1, 90, "the doorstop does not count"],
          ["Contingency", 1, 800, ""]
        ];
        var sum = 0, out = ["item,qty,unit_cost,total,note"];
        rows.forEach(function (r) { var t = Math.round(r[1] * r[2]); sum += t; out.push([r[0], r[1], r[2], t, r[3]].join(",")); });
        out.push(["TOTAL", "", "", sum, ""].join(","));
        return T("budget-2027.csv", "2026-10-16", out.join("\n"));
      })(),
      T("reviewer-comments-2024.txt", "2024-05-20", `
Reviewer comments, 2024 round (funded)

Reviewer 1: A modest, well-run programme. Recommend.

Reviewer 2: Is it necessary to count every day?
  IO response: Yes.

Reviewer 2 (second round): Could the response be expanded?
  IO response: Cranes arrive every day. Yes.

Reviewer 3: The budget line "it is always the fuel filter" is not a budget justification.
  IO response: Removed.
  (It is always the fuel filter.)
`),
      B("harbour-trust_letter-of-support.pdf", "2026-10-02", "182 KB"),
      B("ringing-licence_2026-27.pdf", "2026-08-21", "96 KB"),
      B("ethics-approval_HM-2026-04.pdf", "2026-06-11", "240 KB")
    ])
  ]);

  /* ---------------- /home/tomas ---------------- */
  var ringingFiles = function (withNames) {
    var kids = [
      IMG("2023-10-04_0632_marsh-before-dawn.webp", "2023-10-04", "foggy-pines.webp", "3600x3600", "3.9 MB"),
      B("IMG_2219.cr3", "2023-10-04", "28.4 MB"),
      B("IMG_2226_catching-pen.cr3", "2023-10-04", "27.9 MB"),
      B("IMG_2231_K17-in-hand.cr3", "2023-10-04", "29.1 MB"),
      B("IMG_2240_release.cr3", "2023-10-04", "28.7 MB")
    ];
    if (withNames) kids.push(T("names.txt", "2023-10-04", `
Ringing day, 4 Oct 2023. Written on the station machine at ten at night because otherwise I'll forget. T.

K17. Juvenile, 3.98 kg. Ines rang it at 07:10 by the north pool. I photographed. Wren held the tea and the torch and, at one point, the bird's head, gently, which Ines says you are not supposed to do and Wren says the bird didn't mind.

We named it over dinner.

Ines said it already had a name and the name was K17. Then later, at the sink, said "goodnight, Seventeen" to the dark window. I heard.

Mine is Ash. For the grey at the back of its neck, like it stood too close to a fire.

Wren wouldn't say. Said some names are for keeping, and wrote something down, and put it somewhere nobody looks.
`));
    return kids;
  };

  var tomas = D("tomas", "2026-10-18", [
    D(".config", "2026-09-30", [
      D("tauri-explorer", "2026-10-01", [
        T("settings.json", "2026-10-01", settings(SETUP.tomas, { thumbnailSize: "large", plugins: { "ai-images": false } },
          "Tiles, because I think in pictures. Preview pane, because I would rather look than open. Floating cards on the warm light theme, so it feels like prints on a table. The AI image plugin is switched off on purpose: I don't want anything near my photos that could paint a ring onto a bird."))
      ])
    ]),
    T(".bash_history", "2026-10-18", `
cd ~/Recordings
ls -lh
sox 2026-10-11_0538_north-pool.flac -n trim 2:08 0:08 spectrogram -o /tmp/call-1011.png
sox 2026-10-07_0530_north-pool.flac -n trim 11:30 0:10 spectrogram -o /tmp/call-1007.png
sox 2026-10-16_0550_north-pool.flac -n trim 31:00 0:10 spectrogram -o /tmp/call-1016.png
ls /tmp/*.png
play 2026-10-11_0538_north-pool.flac trim 2:08 0:08
play 2026-10-16_0550_north-pool.flac trim 31:00 0:10
play 2026-10-11_0538_north-pool.flac trim 2:08 0:08
play 2026-10-16_0550_north-pool.flac trim 31:00 0:10
du -sh ~/Recordings
df -h /media/backup
ls ~/Pictures/2026-autumn
`),
    D("Pictures", "2026-10-16", [
      D("2026-autumn", "2026-10-16", [
        IMG("2026-09-29_ferry-port_blue-hour.webp", "2026-09-29", "city-blue-hour.webp", "3600x3600", "3.4 MB"),
        IMG("2026-09-30_arrival_sea-cliffs.webp", "2026-09-30", "sea-cliffs.webp", "3600x3600", "4.6 MB"),
        IMG("2026-10-04_dune-ridge_sunset.webp", "2026-10-04", "dunes.webp", "3600x3600", "3.1 MB"),
        IMG("2026-10-04_dune-ridge_sunset_edit.webp", "2026-10-05", "dunes.webp", "3600x3600", "3.2 MB"),
        IMG("2026-10-07_mist-over-the-marsh.webp", "2026-10-07", "hero.webp", "6144x4096", "7.8 MB"),
        IMG("2026-10-08_marsh-panorama.webp", "2026-10-08", "footer.webp", "9216x2904", "9.4 MB"),
        B("2026-10-10_north-hide-roof_DSC0412.cr3", "2026-10-10", "31.2 MB"),
        B("2026-10-10_north-hide-roof_DSC0413.cr3", "2026-10-10", "30.8 MB"),
        B("2026-10-13_north-pool_DSC0498.cr3", "2026-10-13", "32.0 MB"),
        IMG("2026-10-16_sea-cliffs_again.webp", "2026-10-16", "sea-cliffs.webp", "3600x3600", "4.6 MB"),
        T("contact-sheet-notes.md", "2026-10-16", `
# Contact sheet notes, autumn 2026

Keepers get a star. Everything else stays until I need the space.

## 29 Sep
- ferry-port_blue-hour: the mainland side, waiting for the boat. Last streetlight for two months. Star, for sentiment.

## 30 Sep
- arrival_sea-cliffs: the headland from the boat, sun going. Star. First frame of the season and probably the best, which is annoying.

## 4 Oct
- dune-ridge_sunset: the dunes behind the south track at 18:40. The _edit is the same frame with the warmth overcooked on purpose. Ines prefers the plain one. Ines is wrong.

## 7 Oct
- mist-over-the-marsh: fog lying in the reed channels like milk in tea. Wide. Star.

## 8 Oct
- marsh-panorama: seven-frame stitch from the dyke. There is a seam in the third tree from the left that only I will ever see.

## 10 Oct
- DSC0412, DSC0413: north hide roof, morning after. Record shots for the insurance letter. Not pictures.

## 11 Oct
- 0541_north-pool_soft: one frame. A crane lifting off the north pool, low, into no light at all. 1/15 handheld, ISO through the roof. Legs trailing. Something on the left leg that could be a ring or could be mud, and grey on the nape, or that's the noise.
- Ines asked if the ring was readable. It wasn't. Ines needs a ring read, not a feeling. Binned it.

## 13 Oct
- DSC0498: north pool at first light. Count them yourself; I stopped at twenty.

## 16 Oct
- sea-cliffs_again: same frame as the 30th, same rock, on purpose. One a week until we leave, then stack them.
`)
      ]),
      D("2023-10-04 ringing (restored)", "2025-03-14", ringingFiles(false)),
      IMG("2026-08-14_lake-before-the-job.webp", "2026-08-14", "alpine-lake.webp", "3600x3600", "4.2 MB"),
      IMG("2026-08-20_canyon-walk.webp", "2026-08-20", "river-canyon.webp", "3600x3600", "4.0 MB")
    ]),
    D("Recordings", "2026-10-17", [
      D("2025-autumn", "2025-10-21", [
        flac("2025-09-29_1805_north-pool_arrivals.flac", "2025-09-29", 12),
        flac("2025-10-06_0915_ringing_P05.flac", "2025-10-06", 26),
        flac("2025-10-21_0700_last-skeins-leaving.flac", "2025-10-21", 47),
        T("log-2025.md", "2025-10-21", `
# Recording log, autumn 2025

- 2025-09-29_1805_north-pool_arrivals: twelve minutes, evening. A family party coming down onto the north pool, calling the whole way in. Ines on the scope next to me went very still and said "K17". Ash is back. I didn't say Ash out loud. Ines would have made a face.
- 2025-10-06_0915_ringing_P05: ringing day two. Mostly Ines saying "hold the legs" and me saying "I am holding the legs". At 03:12 in, the bite. Keeping it.
- 2025-10-21_0700_last-skeins-leaving: the big departure. Wave after wave going south over the station. Wren came out in an apron and stood on the step until the last one had gone. Didn't say anything. I didn't either.
`)
      ]),
      flac("test test one two DO NOT KEEP (final) v3.flac", "2026-09-30", 1),
      flac("2026-10-01_0612_reedbed_arrivals.flac", "2026-10-01", 22),
      flac("2026-10-03_0547_south-scrape.flac", "2026-10-03", 31),
      flac("2026-10-05_1930_roost-flight.flac", "2026-10-05", 18),
      flac("2026-10-07_0530_north-pool.flac", "2026-10-07", 40),
      flac("2026-10-09_2140_storm-from-the-porch.flac", "2026-10-09", 63),
      flac("2026-10-10_0012_station-with-nothing-running.flac", "2026-10-10", 9),
      flac("2026-10-10_0602_north-hide-roof.flac", "2026-10-10", 6),
      flac("2026-10-11_0538_north-pool.flac", "2026-10-11", 14),
      flac("2026-10-13_0544_north-pool.flac", "2026-10-13", 35),
      flac("2026-10-16_0550_north-pool.flac", "2026-10-16", 38),
      flac("2026-10-17_0712_kitchen_porridge.flac", "2026-10-17", 4),
      T("recording-log.md", "2026-10-17", `
# Recording log, autumn 2026

File, length, rig, what's on it. Start times are station clock. 24-bit/48k unless noted. A star means worth playing to someone.

## 30 Sep
- test test one two DO NOT KEEP (final) v3: thirty seconds of me saying "test" into the pocket recorder on the boat. I keep not deleting it. It has gulls on it.

## 1 Oct
- 2026-10-01_0612_reedbed_arrivals, 22 min, stereo pair on the south hide sill. First flight-out of the season. From 07:02 the roost lifts in waves; at 07:09 the big one, two hundred birds going over at once. Ines's tally clicker audible throughout, which I'm calling percussion. Star.

## 3 Oct
- 2026-10-03_0547_south-scrape, 31 min, pair plus shotgun. Quiet. Teal, a water rail having an argument with itself, cranes waking at 06:40. Not a star, but a good bed for something.

## 5 Oct
- 2026-10-05_1930_roost-flight, 18 min, pair on the dyke. Birds coming in to roost after dark, calling down. At 19:41 a unison call from a pair right overhead. Star.

## 7 Oct
- 2026-10-07_0530_north-pool, 40 min, north pool rig (mic 1 on the hide post, mic 2 on the old feeder post). The north pool lot at dawn, twelve or fourteen birds. One bird with a lower, rougher call that always starts the others off. Star. Ash, I think. But I would think that.

## 9 Oct
- 2026-10-09_2140_storm-from-the-porch, 63 min, pocket recorder in Wren's sock, taped to the porch rail. The storm arriving. At 22:58 something big lets go on the north side: the hide roof, though we didn't know it then. Star, for the wrong reasons.

## 10 Oct
- 2026-10-10_0012_station-with-nothing-running, 9 min. Power out since 23:12. No generator, no fridge, no hum. Wind, the roof, the kitchen clock. I have never heard this building before. Star.
- 2026-10-10_0602_north-hide-roof, 6 min. The loose sheet banging. For the insurance letter, and for me.

## 11 Oct
- 2026-10-11_0538_north-pool, 14 min, north pool rig, mic 2 only (mic 1 cable cut in the storm). Before light.
- 05:38 to 05:40: wind, water in the reed fringe, the loose roof sheet a long way off.
- 05:40:12: one call. Single bird. Loud on mic 2, so within twenty metres of the old feeder post. Not a unison call; nothing answers it. Low, rough start.
- After that: nothing. One call, then nothing.
- 05:41: I took one photo towards it. See the contact sheet.
- 05:49: footsteps on the dyke, no torch, heading north. Back again at 05:58. Assumed Ines.
- 05:53: a short dry rattle near mic 2. Wind on the reed tops, probably.
- Played the call to Ines at breakfast. It has the low rough start. That's all I'll say. A call is not a ring. I know that. Ines knows that. Logged as heard, unidentified.

## 13 Oct
- 2026-10-13_0544_north-pool, 35 min, north pool rig (mic 1 re-cabled). Far more birds than on the 7th. From 05:51, feeding: dry pecking on something hard, very close to mic 2. The pool is mud. What are they pecking? At 06:02 something large walks slowly through the reeds right past mic 2. No call. Star.

## 16 Oct
- 2026-10-16_0550_north-pool, 38 min, north pool rig. Busier again. Feeding by mic 2 from the start. At 06:21 the low rough call, once, from the reeds, and then the others start. I've played it forty times. I'm not putting a name next to it.

## 17 Oct
- 2026-10-17_0712_kitchen_porridge, 4 min, pocket recorder on the windowsill. Wren making porridge. Spoon, pan, lid, the shipping forecast, Ines asking if there's coffee, Wren saying "there's always coffee", the kettle clicking off. Star. Best thing I've recorded all month, and I'm including the storm.
`)
    ]),
    D("Gear", "2026-10-17", [
      T("gear-list.md", "2026-09-29", `
# Gear, autumn 2026

## Recorders
- Main recorder, the grey one. Four inputs, of which I use two and dream about four. Preamps quiet enough that the noise floor is the sea, which is correct.
- Pocket recorder. Lives in the coat. Has caught more good sound by accident than the main one has on purpose. I resent it.

## Microphones
- Stereo pair, small-diaphragm, in the blimp. The workhorses.
- Shotgun. Everyone thinks they need one. You don't. I brought one anyway.
- Two omnis for the north pool rig. Positions in mic-placement-north-pool.txt.
- Hydrophone. Brought for the dyke sluice. Have recorded mostly my own boots.

## Wind
- Blimp and dead cat. Without the dead cat the north pool sounds like someone blowing across a bottle for an hour. With it, it sounds like the north pool. See windshield-is-called-a-dead-cat.txt for the argument.
- Wren's sock, for the storm. Worked better than the expensive cover. Not telling the manufacturer.

## Camera
- The body with the good sensor. 1/15 handheld before dawn is a promise it cannot keep.
- 100-400 zoom. Heavy. Worth it for every frame that isn't before dawn.
- 35 mm for everything that doesn't move.

## Power
- 48 AA rechargeables in two crates, labelled "charged" and "lies". See battery-log.csv.
- Never trust a battery that has been in the hide overnight. The cold takes a third.

## Would not bring again
- The folding chair. It folds when you sit in it.
- The second shotgun. See above.
- Optimism about the ferry timetable.
`),
      T("battery-log.csv", "2026-10-17", `
date,set,location,hours_to_low,note
2026-10-01,A,south hide,9.5,
2026-10-03,B,south hide,9.1,
2026-10-05,A,dyke,8.8,
2026-10-07,B,north hide,6.2,cold night
2026-10-09,pocket,porch,4.0,in a sock; still counts
2026-10-11,A,north hide,5.9,mic 1 dead (cable); one channel
2026-10-13,B,north hide,6.0,
2026-10-16,A,north hide,5.7,the cold takes a third
2026-10-17,pocket,kitchen,11.0,warm; best location on the station
`),
      T("mic-placement-north-pool.txt", "2026-10-12", `
North pool rig. Set 6 Oct, re-cabled 12 Oct.

mic 1   omni, on the north hide post, 1.2 m up, facing the pool.
        Cable cut in the storm (9 Oct). Re-run 12 Oct.
mic 2   omni, on the old feeder post, 60 m NW of the hide, 0.8 m up,
        facing the mud shelf. Survived the storm. Of course it did;
        that post has survived everything.
rec     in the hide, in a dry bag, in a cool box, under the bench.
cable   80 m through the reed fringe, taped at the three places the coots chew.

Note for next year: mic 2 hears the shelf better than anything we own.
Whatever happens on that shelf, mic 2 knows about it.
`),
      T("windshield-is-called-a-dead-cat.txt", "2026-10-09", `
Wren: Why is there a dead cat on the porch.
Me: It's a windshield.
Wren: It's a dead cat.
Me: It's CALLED a dead cat. That's the joke. It's a furry cover that stops wind noise.
Wren: So it's a dead cat.
Me: It is not, and has never been, a cat.
Wren: Then why is it called a dead cat.
Me: ...
Wren: I'm putting it in the shed with the other dead cats.
Me: There are no other dead cats.
Wren: Not with that attitude.

(9 Oct. It is now in the shed. I used Wren's sock instead. The sock worked better.)
`)
    ])
  ]);

  /* ---------------- /home/wren ---------------- */
  var wren = D("wren", "2026-10-18", [
    D(".config", "2026-09-30", [
      D("tauri-explorer", "2026-09-30", [
        T("settings.json", "2026-09-30", settings(SETUP.wren, { showHiddenFiles: false },
          "Tomás set this up. I asked for less. Then less again. It shows me my files in a list, which is what a list is for, and a line at the bottom that tells me how many there are. That's all I need from it. The rest of my day has enough buttons."))
      ])
    ]),
    T(".profile", "2026-03-02", `
# ~/.profile
export EDITOR=nano
cd ~/journal
`),
    T(".bash_history", "2026-10-18", `
ls
nano 2026-10-11.md
ls
nano ../generator/spares/2024/receipts/folded/the-lodger.txt
ls
exit
`),
    D("journal", "2026-10-18", [
      T("2025-09-29.md", "2025-09-29", `
# 29 September 2025

Ines came in from the evening check and said "K17" to the room, the way you'd say "post's here". Then ate two bowls of porridge.

Three days earlier than last year. Same pool.
`),
      T("2026-09-30.md", "2026-09-30", `
# 30 September 2026

Tomás off the boat at four with eleven bags, nine of which are microphones. Ines has been here since the end of August and has gone the colour of the mudflats. Three of us again.

Generator coughing at about 1.9 kW. I'll look at it before it looks at me.

Made the lentil and leek broth. Tomás had thirds and said the boat food had been "an experience".
`),
      T("2026-10-01.md", "2026-10-01", `
# 1 October

Ines came back from the count and said "Seventeen's in" to the porridge pot. Not to me. To the pot.

Fourth autumn. I put an extra spoon of syrup in everyone's bowl and nobody asked why.
`),
      T("2026-10-04.md", "2026-10-04", `
# 4 October

Three years since ringing day. Made the crumble, because somebody has to mark it, and it's always going to be me.

After supper Tomás turned the lights off and played us the reedbed recording from the 1st. You can hear the wings. Ines sat with eyes closed and counted under breath, I swear, counted a recording.
`),
      T("2026-10-09.md", "2026-10-09", `
# 9 October

Wind from the south-west all afternoon, getting louder. Tied down the bins, the bench, the boat trailer, the lid of the water butt. Ines did the evening check early and came back saying all present, the north pool lot huddled on the shelf.

Tomás is on the porch recording the storm with a microphone in a sock. I said the sock was mine. Tomás said it was "for science".

Spring tides on top of it. Water over the dyke path at ten.

If the lights go: torch on the hook by the door. Spare fuel filter in the box in the shed marked 2024.
`),
      T("2026-10-10.md", "2026-10-10", `
# 10 October

Lights went at twelve minutes past eleven. The battery thing beeped for most of an hour and then gave up too. I lay there listening to the roof and thinking about the fuel.

Out at four with the torch. Water in the filter bowl; the storm got into the tank somehow. Changed the element, bled it, swore at it, and it started on the second go at twenty past four. Kettle on at half past. Best tea of the year.

At first light the north hide had lost half its roof, the seaward side, peeled back like a tin. Nobody in it, thank goodness. Nobody ever is at night.

Ines went out at seven, came back at eight, sat at the computer and typed for a long time. Then said "two hundred and thirteen. One fewer." The way you'd read a meter. Then: "Seventeen wasn't read." Then nothing.

Ines didn't eat. I left the porridge on the side with a plate over it. It was gone by eleven.

Made storm bread by the window because the oven was the only warm thing.
`),
      T("2026-10-11.md", "2026-10-11", `
# 11 October

Up at half four to check the generator, which is fine and smug about it. Couldn't go back to sleep. Took the thermos along the dyke to look at the north hide roof in the dark, which is a stupid thing to do, and I did it anyway.

Just before quarter to six, from the north pool, one call. One crane. Close.

One call, then nothing.

I stood there a long time. My hands got cold. It didn't call again.

I went back to the store and filled the blue bucket with barley, two kilos near enough, and carried it out to the mud shelf by the old feeder post, where the shelf stays dry at low water. Tipped it out in a line. Came back. Didn't tell anyone.

The handbook says nobody feeds the cranes. I know what it says. I wrote half of it.

Breakfast was quiet. Tomás had been out at the north pool before light too, it turns out, recording, and came in pale and said "maybe" to Ines, and Ines went to the computer, and later went to the computer again.
`),
      T("2026-10-12.md", "2026-10-12", `
# 12 October

Barley gone from the shelf. Prints all over the mud, the big three-toed ones, a lot of them, more than one bird's worth. Could be anyone's. Could be.

Two more kilos.

Ines and Tomás went to look at the north hide to see what can be saved. Tomás recorded the loose sheet banging and called it the best percussion of the season.
`),
      T("2026-10-14.md", "2026-10-14", `
# 14 October

Out at five with the bucket. There was a crane already on the shelf. Light not up. I stopped where I was and it didn't go.

I couldn't see a ring. I couldn't have seen a ring in that light if it had been painted on a door. But it stood the way that one stands, on one leg, head turned out of the wind as if the rest of us are a rumour, and there was the grey on the nape, or I wanted there to be.

Then it walked off into the reeds, and I put the barley down and went home and made porridge with my hands shaking, which Tomás noticed, and I said it was the cold.

Ines at lunch: the north pool is up to twenty-four. "There's nothing to eat there." I said maybe they like the view.
`),
      T("2026-10-15.md", "2026-10-15", `
# 15 October

North hide roof, with Tomás. Tarp, battens, forty-one screws, one thumb. Mine.

Ines brought tea out to the hide at eleven, which has never once happened in four years, and stood holding the ladder for an hour saying nothing at all. That's how Ines says things.
`),
      T("2026-10-17.md", "2026-10-17", `
# 17 October

Seventh morning. Fourteen kilos, all told. I wrote the week down in the-lodger.txt, in with the receipts, where nobody looks.

Ines at dinner said the north pool had thirty-one this morning and "it does not make sense", and that the computer had started flagging it, which Ines seemed to take personally. I said maybe they like it there. I was given a look I have been given before.

I'll stop tomorrow. Either it's eating or it isn't, and either way the count shouldn't have to carry my hoping around for it.
`),
      T("2026-10-18.md", "2026-10-18", `
# 18 October

Didn't go out. Lay awake from half four listening for it instead, which is not the same thing.

Tomás asked me over the porridge if I'd ever deleted something and then wished I hadn't. I said I burnt a letter once and it was the best thing I ever did. Tomás laughed, and then didn't.

Barley 21.5 kg. Ordered more. Wrote "for bread".

Ines added a new word to the counting rules this morning, "unconfirmed", and read it out to us like a weather forecast, looking at Tomás the whole time.

I think I'll tell Ines. Not today.
`)
    ]),
    D("letters", "2026-10-16", [
      T("to-ines.md", "2026-10-16", `
# Ines

Not sending this. Writing it so it's out of my head and onto something.

You wrote "missing" on the 10th. I watched you do it. You typed it like a meter reading, and then you sat with your hands in your lap for a while, which you never do. Your hands are always doing something.

I know that's how you carry things. You put them in the right column and the column holds them for you. I'm not like that. I put things in the pantry.

I've been doing something silly in the mornings. If it works I'll tell you, and you'll be cross about the count, and you'll be right, and I'll make pancakes.

If it doesn't work I'll never tell you, and you can keep your column.

W.
`),
      T("to-the-next-keeper.md", "2026-05-03", `
# To whoever keeps this place after me

Not yet. But one day, so I'm writing it while I remember.

## The generator
- It likes to be warm before you ask anything of it.
- If it stops in a storm, it's the fuel filter. It is always the fuel filter. There should be a spare in the box marked with the year. If there isn't, I've failed you, and I'm sorry.
- Talk to it if you like. I do. The keeper before me left a note under the sink saying the same, which is how I knew it wasn't just me.

## The people
- Counters get up before light and come back hungry and won't say so. Have something hot on the side with a plate over it.
- Sound recordists will ask you to stop whatever you're doing because of a bird three miles away. Stop. It's usually worth it.
- Nobody will tell you how they are. Watch who eats.

## The kitchen
- A sack of barley is a quarter-kilo a day for three people. Know your sacks and you'll know everything else.
- Bread on Sundays. Crumble on the 4th of October. Don't ask, just do it.

## The cranes
- They come in the first days of October and leave when the frost settles, and for those weeks the place belongs to them, not us.
- Some come back. You'll start to know them. You'll pretend you don't.
- The handbook says nobody feeds them. It's right. I'm telling you so you'll know I knew.
`),
      T("to-the-roads-department.md", "2026-10-03", `
# To the Roads Department

Dear Roads Department,

Further to my letters of March 2024, March 2025 and last Tuesday, I write again about the track from the ferry slip to the station, which your map calls a road and which the station calls the trench.

Since my last letter the trench has acquired a pond. The pond has acquired a heron. The heron now has a better claim to the road than we do, having been there longer than your last inspection.

I enclose a recording, made by our sound recordist, of a delivery van attempting the trench on 2 October. The bit where the driver gives up is about four minutes in. I recommend it.

We are not asking for tarmac. We are asking for gravel, and for somebody to come and look.

Yours, with the patience of someone who lives at the end of it,

Wren Adair
Keeper, Hollin Marsh Field Station
`),
      T("to-my-sister.md", "2026-09-22", `
# Dear Maud

The boat brought your parcel. The socks are perfect and one of them has already been requisitioned by a sound recordist "for science". I'll explain at Christmas. I won't be able to explain at Christmas.

It's quiet here before they all arrive, the people and the birds. I like it and I like it less than I used to. I think that means I've got used to company, which you said would happen and I said wouldn't.

The generator and I are getting on. The apple tree has done well. I've started writing down what everyone eats, which sounds odd until you've kept a station.

Love to the dog. Tell the dog I've met a heron who'd frighten it.

W.
`)
    ]),
    D("recipes", "2026-10-10", [
      T("storm-bread.md", "2026-10-10", `
# Storm bread

For when the boat isn't coming, there's no yeast, and everyone is looking at you.

No rising, no waiting. Forty-five minutes from the flour bin to the table. Made it on the 10th by the oven door, more or less, before anyone else was up.

## Makes one round loaf
- 450 g plain flour (or 350 plain and 100 of whatever wholemeal is left)
- 1 level teaspoon bicarbonate of soda
- 1 level teaspoon salt
- 400 ml sour milk, or 350 ml milk with the juice of a lemon stirred in and left for ten minutes
- If neither: 350 ml water and three big spoons of yoghurt. If no yoghurt, it's a different recipe and we don't talk about it.

## Method
- Oven as hot as it goes. Flour a tray.
- Sift the flour, soda and salt together. Actually sift. A lump of soda tastes like licking a battery.
- Make a well. Pour in most of the milk. Mix with one hand, fingers spread like a claw, from the middle outwards. Add the rest of the milk if it's dry. It should be soft and a bit sticky, not wet.
- Do not knead. This is the whole secret. Bring it together, turn it onto the tray, pat it into a round about 4 cm thick. Thirty seconds of handling, no more.
- Cut a deep cross on top, nearly to the edges, so the heat can get into the middle.
- Fifteen minutes at full heat, then down to medium for twenty-five more.
- Knock on the bottom. Hollow means done.
- Wrap it in a damp tea towel while it cools if you want a soft crust. Leave it bare if you want it crackly.

## Notes
- The soda starts working the moment it meets the milk. Have the oven hot before you start, not after.
- Eat it the same day. It's a stone by tomorrow. Toast it the day after and nobody will know.
- Ines likes it with nothing. Tomás likes it with everything. I like it with the end of the cheese and the radio on.
`),
      T("porridge-for-three.md", "2026-09-30", `
# Barley porridge for three

What Ines calls gruel and eats two bowls of.

## For three
- 250 g pearl barley, soaked overnight in the big pan (put it on before bed or you'll be eating it at lunch)
- 1.2 L water, or half milk if the boat came
- a pinch of salt
- golden syrup, stewed apple, or the jar of blackberries if anyone picked any

## Method
- Drain the soaking water, add fresh, bring up to a simmer.
- Lid on, lowest heat, forty minutes. Stir when you pass it.
- Salt at the end, not the start, or the grains stay hard.
- Done when it holds a spoon upright for a count of three.
- Syrup for Tomás. Nothing for Ines, who says sugar before a count makes the numbers wobble. Apple for me.

## Notes
- A quarter-kilo a day, every day. I know exactly how long a sack lasts. That's the job.
`),
      T("tin-curry.md", "2026-10-17", `
# Tin curry

Everything in this comes out of a tin or a jar, so it works in the second week after a missed boat, which is when you need it most.

## For three, with some left for the hide
- 1 onion, or 2 if they're the small sprouting ones
- 2 cloves garlic
- a thumb of ginger if there is one; a teaspoon of the dried stuff if not
- 2 teaspoons cumin, 1 of the jar with no label (probably coriander), half of chilli
- 1 tin tomatoes
- 2 tins chickpeas, drained
- 1 tin coconut milk (if Tomás hasn't found them)
- a handful of red lentils to thicken it
- salt, a squeeze of lemon, rice

## Method
- Onion soft in oil, slowly, ten minutes. Don't rush it. The onion is the whole flavour.
- Garlic and ginger, one minute. Spices, one minute more, until the kitchen smells like somewhere warmer.
- Tomatoes, chickpeas, lentils and a tin of water. Simmer twenty minutes.
- Coconut milk, five minutes more. Salt. Lemon.
- Rice on when the tomatoes go in and both are ready together, if you're lucky.

## Notes
- Better the next day. Carry it out to the hide in the flask for whoever's counting.
- The printer printed this one. It has never printed anything of Ines's. Draw your own conclusions.
`),
      T("windfall-crumble.md", "2026-10-04", `
# Windfall crumble

Made every 4 October, because that was ringing day in 2023 and somebody has to mark it.

## For three greedy people
- 6 windfall apples from the keeper's tree, bruised bits cut out
- 2 spoons of sugar for the apples, more if they're the sour ones
- 100 g plain flour
- 75 g oats
- 75 g cold butter, in cubes
- 75 g sugar
- a pinch of salt, and cinnamon if we have any

## Method
- Apples peeled, cored, in chunks, into the dish with the sugar and a splash of water.
- Rub the butter into the flour with your fingertips until it looks like wet sand. Stir in the oats, sugar and salt.
- Scatter it over the apples. Don't press it down.
- Medium oven, 35 minutes, until the edges bubble up purple-brown.

## Notes
- Ines says crumble is not a celebration. Ines had two helpings on the 4th.
`),
      T("lentil-and-leek-broth.md", "2026-09-30", `
# Lentil and leek broth

First night of the season, every season. Feeds three tired people and one more who turns up.

## What goes in
- 3 leeks, washed properly (the grit hides in the top end)
- 2 carrots, 2 potatoes, 1 onion
- 200 g red lentils
- 1.5 L stock, or water and a stock cube and a bay leaf
- butter, salt, pepper, a squeeze of lemon at the end

## Method
- Leeks and onion in butter, low, lid on, ten minutes, until they slump.
- Carrots, potatoes, lentils, stock. Simmer half an hour, until the lentils have given up.
- Mash a bit of it against the side of the pan. Leave the rest chunky.
- Lemon and pepper. Bread on the side.
`)
    ]),
    T("supplies.md", "2026-10-18", `
# Supplies

Counted 18 Oct. Next boat 24 Oct, weather permitting, which it won't.

## Pantry
- Barley: 21.5 kg (40.0 on 1 Oct; 37.5 on the 10th)
- Oats: 6 kg
- Rice: 9 kg
- Red lentils: 4 kg
- Plain flour: 12 kg
- Tins of tomatoes: 14
- Tins of chickpeas: 9
- Coconut milk: 5 (hidden from Tomás)
- Onions: about 30, some growing
- Leeks: 11, going soft
- Apples: one crate of windfalls from the keeper's tree
- Golden syrup: 1 tin, the last one
- Salt, pepper, cumin, and the jar with no label that is probably coriander

## Fuel
- Diesel: about 410 L after the 12th's top-up. The generator takes about 9 L a day.
- Spare fuel filter elements: 1 (used one on the 10th; order 3)
- Gas for the cooker: 1 bottle and the one in use

## Order for the boat
- Barley, 25 kg. (Porridge is a quarter-kilo a day for the three of us. I know.)
- Fuel filter elements x3
- Roofing felt, 2 rolls, for the north hide properly
- AA batteries x40 (Tomás says 48; Tomás can carry them)
- Lemons
- Coffee, because Ines will not survive without it and neither will we
`),
    T("repairs.md", "2026-10-15", `
# Repairs

## Done
- Generator, 10 Oct, 04:20. Fuel starvation. Water in the filter bowl. Changed the element (the spare from the 2024 box), bled the line, started on the second go.
- North hide roof, 15 Oct. Tomás and me. Tarp, battens, forty-one screws, one bruised thumb (mine). Ines counted from the dyke until then and did not complain out loud.
- Kettle: still reports to the computer. I don't know why it does that. Leaving it.

## To do
- North hide roof, properly, with felt, when the boat brings it.
- The south hide door sticks in wet weather, which is all weather.
- Gutter over the porch. Tomás says it's "a good sound". It is a leak.
- Fuel tank: drain the water off the bottom before winter. The storm got in somewhere. Filler cap seal is perished.
- Printer. It says it's out of paper. It has paper. We have an understanding.
`),
    T("tides-2026-10.csv", "2026-10-01", tideCsv()),
    D("generator", "2026-10-17", [
      T("service-log.md", "2026-10-11", `
# Generator service log

- 2024-03-11: Bought fuel filter elements x3. Receipt in spares/2024/receipts.
- 2024-06-02: Raw water impeller replaced. The old one had lost four vanes. Found two.
- 2025-01-17: Stopped at 02:00 in the frost. Fuel filter (1 of 3). Running again by 03:10.
- 2025-09-20: Oil and oil filter. 1,410 hours.
- 2026-04-02: Oil. 1,980 hours. Filler cap seal still perished; on the boat list.
- 2026-10-09: Stopped 23:12 in the storm. Fuel starvation.
- 2026-10-10: Water in the bowl. Fuel filter (2 of 3). Bled, started on the second go at 04:20. 2,618 hours. One element left.
- 2026-10-11: Up at half four to check it. It was fine. I knew it would be fine.
- 2026-10-12: Topped up from the drums, 180 L.
`),
      T("manual-excerpt.txt", "2019-05-02", `
GENERATOR: OPERATOR'S MANUAL (excerpt, section 7: Troubleshooting)
Photocopied 2019. Pencil annotations transcribed in [brackets].

7.3 Engine stops under load / will not restart
    Probable cause: fuel starvation.
    Check: fuel level; fuel shut-off valve; primary filter bowl for water or sediment.
    Remedy: drain filter bowl. Replace filter element. Bleed fuel system (7.4).
    [It is always the fuel filter. - R, 2019]
    [Confirmed. - W, 2025]
    [Confirmed again. In the rain. - W, 10 Oct 2026]

7.4 Bleeding the fuel system
    1. Open bleed screw on filter head (10 mm).
    2. Operate priming lever until fuel free of air bubbles issues from screw.
       [the priming lever is the bit that looks like it shouldn't move. it moves.]
    3. Close bleed screw. Do not overtighten.
    4. Crank engine. If engine fails to start after 3 attempts of 10 s,
       wait 2 min and repeat 7.4.
       [second go, usually. talk to it.]

7.5 Water in fuel
    Water entering the fuel tank may cause repeated starvation faults.
    Remedy: drain tank sump before cold season. Check filler cap seal.
    [cap seal perished. on the boat list. - W]
`),
      D("spares", "2026-10-10", [
        T("inventory.txt", "2026-10-10", `
Spares box (shed, top shelf, the one marked 2024)

fuel filter elements    1    (was 3: used 2025-01-17, 2026-10-10)
oil filters             2
impellers               1
fan belt                1
bleed screw washers     a bag
fuses 10A               6
fuses 15A               0    (who)
torch bulbs             4    (for the torch nobody uses because of the other torch)
`),
        D("2024", "2024-06-02", [
          D("receipts", "2026-10-17", [
            B("2024-03-11_fuel-filters-x3.pdf", "2024-03-11", "88 KB"),
            B("2024-06-02_impeller.pdf", "2024-06-02", "71 KB"),
            D("folded", "2026-10-17", [
              T("the-lodger.txt", "2026-10-17", `
THE LODGER

2023, 4 Oct.
Ringed this morning. Small and furious. Ines held the legs, Tomás held the
camera, I held the tea and, for a moment, the head. They wanted a name.
I said I'd keep mine to myself.

It's the Lodger. Turns up in autumn, eats my food, leaves without paying,
and I miss it every March.

2024, 2 Oct.
Back. Ines read the ring, said "K17" to the scope and nothing else all
morning. Then made everyone pancakes, which has never happened before or since.

2025, 29 Sep.
Back, three days early. Same pool. Same trick of standing with its head
turned out of the wind like it's ignoring all of us.

2026, 1 Oct.
Back.

2026, 10 Oct.
Not read, after the storm. Ines wrote "missing".

2026, 11 Oct.
One call from the north pool before light. Barley on the shelf by the
old feeder post. 2 kg.

2026, 12 Oct.  2 kg. Gone by morning. Prints.
2026, 13 Oct.  2 kg.
2026, 14 Oct.  2 kg. A crane on the shelf before light. One leg.
               Head out of the wind. I didn't see a ring. I didn't look
               for one. I didn't want to be told no.
2026, 15 Oct.  2 kg.
2026, 16 Oct.  2 kg.
2026, 17 Oct.  2 kg. Fourteen. That's the week.

Stopping tomorrow. If it's the Lodger, it knows where the shelf is.
`)
            ])
          ])
        ])
      ])
    ])
  ]);

  /* ---------------- /srv/station ---------------- */
  var srv = D("srv", "2026-10-18", [
    D("station", "2026-10-18", [
      T("handbook.md", "2026-09-12", `
# Hollin Marsh Field Station: Handbook

Kept by whoever is keeper. Edited by everyone, argued over by everyone. Last revised September 2026.

## The station
- Three bedrooms, one kitchen, one workstation (hollin-marsh), one generator, two hides, one dyke, one track the map calls a road.
- Mains power: none. The generator runs day and night through the season. The battery covers the workstation for about 45 minutes if it stops.
- Water: rain butts and the borehole pump. If the taps cough, the pump is airlocked. There is a note about this under the sink, and has been since 2019.
- Boat: Thursdays, weather permitting. Weather does not permit.

## Rules
- Rule 1: Sign out on the whiteboard if you go past the dyke gate. Sign back in.
- Rule 2: No one in the hides between dusk and the dawn count unless they've told someone.
- Rule 3: Nothing wet on the keyboard.
- Rule 4: Whoever cooks does not wash up.
- Rule 5: Recording the washing up is not doing the washing up. (Added 2025. See the rota.)
- Rule 6: The good knife lives on the magnet. It does not live in the hide.
- Rule 7: Lights off in the north rooms during the evening flight. They can see us.
- Rule 8: The counts are the counts. Report them as they are, not as we'd like them.
- Rule 9: Nobody feeds the cranes. It changes where they stand, and then the count is a count of our kindness instead of a count of cranes.
- Rule 10: If in doubt, put the kettle on.

## The hides
- North hide: faces the north pool and the mud shelf. The old feeder post 60 m north-west is from before Rule 9; leave it standing. Roof patched 15 Oct 2026.
- South hide: faces the scrape and, from the side window, the reedbed roost. The door sticks.
- Neither hide has heating. Both have a flask hook. Use it.

## The count
- Dawn, every day, October to departure. Ines runs it. Nobody else touches the clicker.
- Rings are read by scope. No ring read, no record. (Ines would like it known this is not negotiable.)
- Counts are exported to counts-latest.csv in this folder after each count.

## If someone is hurt
- First-aid kit: porch, top shelf, red bag.
- Coastguard number is on the fridge, under the wifi password.
- Nearest doctor: the mainland, forty minutes by boat in good weather.

## The shared folder
- /srv/station is everyone's. The rota is binding. The whiteboard is not.
- The grey drive marked BACKUP goes in on Sundays. Ines has the restore notes.
- do-not-open is exactly what it sounds like.
`),
      T("rota.md", "2026-10-13", `
# Rota, October 2026

## Cooking
- Mon, Wed, Fri, Sun: Wren
- Tue, Thu: Tomás
- Sat: Ines
- Ines has asked for Saturday to say "toast". Request denied. Request appealed. Appeal pending.

## Washing up
- Whoever didn't cook. That is two of you. Work it out.
- Tomás: recording the washing up is not doing the washing up. (W)
- It's a documentary practice. (T)
- It's a pan with egg on it. (W)
- Rule 5 now exists because of this. (I)

## Generator checks, 06:00 and 22:00
- Wren. Wren has asked that nobody else touches it "because it knows me". Granted.

## Bins to the slip (Thursday)
- Ines, on the way to the scrape.
- The slip is not on the way to the scrape. (I)
- It is if you go the long way. (T, W)
- Overruled. (I)
- Two votes to one. (T, W)

## Sunday
- Backup drive in: Ines.
- Bread: Wren.
- Quiz night: everyone. The answers are where they always are. Do not look. (W)
`),
      T("whiteboard.txt", "2026-10-18", `
Kitchen whiteboard, transcribed 18 Oct 08:50 because the marker is dying. (T)

STORM FRI - DONE
  [x] bins   [x] bench   [x] trailer   [x] water butt lid
  [x] hide shutters (I)   [x] torch on hook
  [x] Wren's sock (requisitioned for science)

N HIDE CLOSED  -> patched 15th, felt on the next boat

COUNTS (dawn)
  9th 214   10th 213   11th 213   12th 218   13th 222   14th 225
  15th 228   16th 231   17th 233   18th 234
  (under the 11th, rubbed out, you can still read "K1")

BOAT THU 24th?  list on the fridge
  barley!!   (who is eating all the barley - I)
  lemons
  AA x48 (T)   x40 (W)
  felt x2

WHO TOOK THE GOOD KNIFE
  not me (T)   not me (I)   it was in the hide (W)

SIGNED OUT PAST THE GATE
  W 04:55 back by breakfast  (11th, 12th, 13th, 14th, 15th, 16th, 17th)
  T 05:25 back 06:30  (11th, 13th, 16th)

QUIZ SUN - Tomás is quizmaster, heaven help us
`),
      T("hides-map.txt", "2025-09-01", `
                                  N
                                  ^
     ~  ~  ~  ~  ~  ~  ~   s e a   ~  ~  ~  ~  ~  ~  ~
   ================== sea wall ===========================
        . . . reed fringe . . .
      (     north pool     )   + old feeder post (mic 2)
       \\_ mud shelf _/
          [N HIDE]
   ------------- dyke path -------------------------  gate
                          |
   [generator shed]   [ STATION ]   [store]
                          |
   (  reedbed roost  )    |                (  south scrape  )
                      [S HIDE] ......................
                          |
                     the "road" to the slip (the trench)
`),
      T("wifi-password.txt", "2024-11-02", `
The wifi password is written on the fridge.

The fridge says: "see wifi-password.txt".

We are aware.
`),
      T("counts-latest.csv", "2026-10-11", SHARED_EXPORT),
      D("archive", "2019-06-30", [
        D("2019-handover", "2019-06-30", [
          T("inventory-2019.txt", "2019-06-30", `
Station inventory at handover, June 2019 (R. to W.)

beds                3   (one of them is a camp bed pretending)
chairs              5   (the folding one is a liar)
kettles             1   (the second one is a bucket now)
torches             2   (one works)
scopes              1   (do not let anyone take it to the pub on the mainland again)
generator           1   (talk to it)
cranes              about 180 at peak, none in June, all of them in October
`),
          D("box-3", "2019-06-30", [
            T("label.txt", "2019-06-30", "BOX 3: KITCHEN, MISC, DO NOT THROW AWAY"),
            D("under-the-sink", "2019-06-30", [
              D("behind-the-u-bend", "2019-06-30", [
                T("note.txt", "2019-06-30", `
To whoever finds this,

If you're reading this you've gone looking under the sink, which means the
taps are coughing, which means the pump is airlocked. The bleed screw is the
brass one on the left of the pump housing. Quarter turn. Wait for water.
Close it. You're welcome.

Some other things nobody wrote down:

- The generator likes to be talked to. I'm not saying it listens.
  I'm saying it starts.
- The north pool is where the old ones go. The young ones try the scrape
  first and learn.
- There used to be a feeder by the north pool, before the rules. The post is
  still there. Leave it. The birds remember it even if we pretend not to.
- The cranes come back. Every year I was sure they wouldn't, after a bad
  winter or a storm, and every year they did. Not all of them.
  More than you'd think.

Keep the kettle full.

R., keeper 2011-2019
`)
              ])
            ])
          ])
        ])
      ]),
      D("do-not-open", "2026-10-15", [
        T("seriously.txt", "2026-10-15", `
This folder contains the quiz answers.

That's it. That's the secret.

Ines, close it.

- W & T
`),
        T("quiz-2026-answers.md", "2026-10-15", `
# Quiz night, 18 October 2026: answers

Quizmaster: Tomás. If you are Ines and you are reading this, put it back.

## Round 1: the station
- How many screws in the north hide patch? 41. Wren counted.
- What does the kettle do that no kettle should? Reports to the computer. It has a log. It has opinions.
- How many days has the printer been out of paper? It has never been out of paper. Ask it yourself.
- What is the wifi password? Nobody knows. Nobody has ever known.

## Round 2: the birds
- What colour ring is on a 2024 bird? Blue.
- Which bird bit the quizmaster? P05. Name withheld for legal reasons.
- What does the K stand for in K17? Nothing. Ines says it's just the 2023 letter. Wren says Keeper. A bonus point to whoever says Keeper with a straight face.

## Round 3: sounds (play from Recordings)
- Track 1, kitchen, 17 Oct. Who says "there's always coffee"? Wren.
- Track 2, porch, 9 Oct. What is the bang at 22:58? The north hide roof.
- Track 3, north pool, 16 Oct, 31 minutes in. Who is that calling?
- No answer on the sheet for track 3. Ask the quizmaster.
`)
      ])
    ])
  ]);

  /* ---------------- /media/backup ---------------- */
  var media = D("media", "2025-03-14", [
    D("backup", "2026-10-11", [
      T("restore-note.txt", "2025-03-14", `
Restore, 14 March 2025 (IO)

TR's laptop died on the boat back in February (salt water; the laptop's
fault, according to TR). Restored TR's 2023 ringing folder from this drive
onto the station machine, at:

  /home/tomas/Pictures/2023-10-04 ringing (restored)

Command used, for next time:

  rsync -av --include='*/' --include='*.cr3' --include='*.webp' --exclude='*' \\
    "/media/backup/Photos 2023/2023-10-04 ringing/" \\
    "/home/tomas/Pictures/2023-10-04 ringing (restored)/"

Images only, because the folder had 3 GB of editing sidecars in it.
If anything else was in there, it is still on this drive.

Drive goes in on Sundays. Label says BACKUP.
The other grey drive is a doorstop, and has been since 2022.
`),
      B("station-backup_2026-10-11.tar.zst", "2026-10-11", "38.2 GB"),
      B("station-backup_2026-10-04.tar.zst", "2026-10-04", "37.9 GB"),
      D("Photos 2023", "2023-11-02", [
        D("2023-10-04 ringing", "2023-10-04", ringingFiles(true)),
        B("2023-11-02_last-cranes-leaving.cr3", "2023-11-02", "29.6 MB")
      ])
    ])
  ]);

  var home = D("home", "2026-09-30", [ines, tomas, wren]);

  /* ---------------- export ---------------- */
  TX.station = {
    title: "Hollin Marsh Field Station",
    users: [
      { id: "ines", name: "Ines Okafor", home: "/home/ines", blurb: "Ornithologist. Runs the dawn count. Trusts columns.", setup: SETUP.ines },
      { id: "tomas", name: "Tomás Reyes", home: "/home/tomas", blurb: "Sound recordist and photographer. Listens first.", setup: SETUP.tomas },
      { id: "wren", name: "Wren Adair", home: "/home/wren", blurb: "Station keeper. Cooks, mends the generator, writes things down.", setup: SETUP.wren }
    ],
    tree: { name: "", kind: "dir", kids: [etc, home, media, srv, usr, varDir] },
    trash: [
      {
        node: IMG("2026-10-11_0541_north-pool_soft.webp", "2026-10-11", "crane.webp", "2880x2880", "5.3 MB"),
        from: "/home/tomas/Pictures/2026-autumn",
        deleted: "2026-10-11"
      },
      {
        node: T("north-pool-what.txt", "2026-10-14", `
it's food. it can't be food. there's no food there.

count it.
`),
        from: "/home/ines/Fieldwork",
        deleted: "2026-10-14"
      },
      {
        node: T("to-ines-draft-1.md", "2026-10-13", `
# Ines

You wrote missing. I
`),
        from: "/home/wren/letters",
        deleted: "2026-10-13"
      }
    ],
    repos: {
      "/home/ines/Projects/crane-counts": { branch: "main", commits: commits }
    }
  };
})();
