# Measured performance

Measured numbers for opening large folders and for basic navigation, with the
method and commands to reproduce each one (#983). Everything here was measured
on the machine below. Nothing is extrapolated: where something was not
measured, this page says so.

## Headline numbers

End-to-end, release binary, Linux, warm cache, Details view, 1200×800 window.
Times run from the input event (double-click or toolbar click) being dispatched
in the page to the destination rows being in the DOM plus two animation-frame
callbacks. n = 20 runs per row after one discarded warm-up; p95 is nearest-rank,
so with n = 20 it is the second-slowest run.

| Folder (flat) | Entries listed (shown) | First rows visible, median / p95 | Listing complete, median / p95 |
|---|---|---|---|
| 1k | 1,000 (791) | 34 / 44 ms | 34 / 44 ms |
| 10k | 10,000 (7,986) | 52 / 56 ms | 52 / 56 ms |
| 100k | 100,000 (79,895) | 266 / 297 ms | 266 / 297 ms |
| 500k | 500,000 (400,328) | 1,653 / 1,706 ms | 1,653 / 1,706 ms |

Navigation on the 100k folder (same method, n = 20):

| Operation | Median | p95 |
|---|---|---|
| Enter folder (double-click from its parent) | 270 ms | 298 ms |
| Go up (from a subfolder into the 100k folder) | 246 ms | 268 ms |
| Back (into the 100k folder) | 252 ms | 262 ms |
| Forward (into the 100k folder) | 269 ms | 290 ms |
| Sort change: Name → Size | 122 ms | 146 ms |
| Sort change: Size → Name | 73 ms | 81 ms |
| Scroll, frame interval while scrolling 120 px per frame | 17 ms | 18 ms |

The scroll figure is 6,000 frame intervals (20 runs × 300 frames, 36,000 px
each): max 28 ms, none over 33.3 ms, and 527 (8.8%) over 17.7 ms (one 60 Hz
frame plus 1 ms). Under Xvfb, WebKitGTK paces animation frames at about 60 Hz,
so 16.7 ms is the floor here, not a rendering cost.

**First rows and complete are equal by design.** The app does not stream a
partial listing: the backend returns one complete snapshot (scan, sort and
encode), and the frontend publishes it in a single update. A large folder
therefore shows nothing new until the whole listing is ready. The two columns
are kept separate because the issue asks for both, and so that a future
streaming change shows up as a difference.

## Test machine and conditions

| | |
|---|---|
| Date | 2026-10-27 |
| App | tauri-explorer 1.13.3, commit `d2049a01` (`dev`) |
| Build | release profile with `tauri/custom-protocol` (the shipping configuration; frontend embedded, no dev server) |
| OS | Arch Linux, kernel 7.2.9-arch1-1 |
| WebView | WebKitGTK 2.54.1 (webkit2gtk-4.1), X11 through Xvfb 21.1.25 (software rendering, devicePixelRatio 1) |
| CPU | AMD Ryzen 9 5900X, 12 cores / 24 threads, max 4.95 GHz, `powersave` governor (amd-pstate-epp) |
| RAM | 62 GiB |
| Fixture disk | NVMe SSD (SPCC M.2 PCIe), ext4 |
| Toolchain | rustc 1.97.1, Node 25.6.0, Bun 1.3.8 |

The machine is a shared desktop that stayed in use during the runs, so this
is not an idle benchmark host. The 1-minute load average at each measurement
was recorded: 1.9–2.2 for the 1k–100k folder rows, 2.2–4.3 (median 4.1) for
the 500k rows and 2.8–4.0 for the navigation rows. The load average includes
the measured app's own work, which is substantial at 500k. Measured processes ran at normal priority;
the builds that preceded them ran at nice 19.

**Not measured:** macOS and Windows (the end-to-end runner drives WebKitGTK
and is Linux-only); Wayland compositors and GPU-accelerated rendering (Xvfb
only); hard-disk and network filesystems.

**Cold cache: not measured.** A directory listing reads directory entries and
inode metadata, not file contents, so the cache that matters is the kernel's
dentry/inode cache. Evicting it needs root (`echo 2 > /proc/sys/vm/drop_caches`)
or an unmount, neither available on this machine. `vmtouch -e` and
`posix_fadvise(POSIX_FADV_DONTNEED)` only evict file data pages, which a
listing never touches, so they would have produced warm-cache numbers labelled
cold. All numbers above are warm: the generator has just written the fixtures,
and a discarded warm-up run precedes every scenario.

## Where the time goes (component layers)

These isolate parts of the pipeline. They are not additive with each other or
with the end-to-end figures: they run in different processes and with different
inputs.

### Rust: directory scan (`bun run bench:rust`)

`scan_directory_parallel` (`src-tauri/src/files/dir_listing.rs`), the parallel
readdir + stat at the core of every listing. Criterion, release profile, same
fixtures as above; median and p95 of per-sample mean iteration times.

| Benchmark | Samples | Median | p95 |
|---|---|---|---|
| fixture `files-1k` | 10 | 1.28 ms | 1.34 ms |
| fixture `files-10k` | 10 | 10.3 ms | 10.7 ms |
| fixture `files-100k` | 10 | 103 ms | 108 ms |
| fixture `files-500k` | 10 | 601 ms | 629 ms |
| `scan_directory_parallel/10k_files` (built-in synthetic fixture) | 100 | 8.47 ms | 9.09 ms |
| `sort_entries/10k_entries` | 100 | 1.22 ms | 1.24 ms |

Load average 1.4 at the start, 6.5 at the end (another process started work
partway through; the 500k samples ran last). The built-in 10k bench measured
5.7 ms in July 2026 according to its header comment; that run's conditions
were not recorded, so the two are not directly comparable.

The scan is roughly 36–39% of the end-to-end time at 100k and 500k (it lists
dot-files too; the frontend hides them). The rest
(Rust sort and wire encoding, IPC, decoding, frontend filtering/sorting and
rendering) is broken down per phase in "Folder-open pipeline (#1417)" below.

### Frontend only (`bun run test:perf`)

Pure TypeScript functions under Node with synthetic entries (no DOM, no IPC),
from `tests/perf/*.bench.ts`. Each harness run reports the mean over its
iterations; the table gives the median and p95 of those means across 5 runs
(load average 2.5).

| Benchmark | Iterations per run | Median | p95 |
|---|---|---|---|
| `sortEntries` by name, 10k | 50 | 4.17 ms | 4.22 ms |
| `sortEntries` by size, 10k | 50 | 1.40 ms | 1.48 ms |
| `sortEntries` by modified, 10k | 50 | 2.99 ms | 3.02 ms |
| `filterHidden`, 10k | 50 | 0.37 ms | 0.42 ms |
| `formatSize`, 10k | 50 | 0.44 ms | 0.48 ms |
| Sort + filter + visible slice, 10k (`dirPipeline-10000`) | 50 | 4.59 ms | 4.64 ms |
| Select all, 10k | 50 | 0.66 ms | 0.72 ms |
| Virtual-list math (`visibleRange-100`, `sliceVisibleItems-10000`, `rapidScroll-10000`) | 50–1,000 | ≤ 0.01 ms | ≤ 0.01 ms |

### Memory (end-to-end run, #983)

Resident set size after the 20th open of each folder, same session (so later
rows include whatever earlier folders left behind). The app runs a main process
plus a WebKit network process and two WebKit web-content processes. This is the
original #983 run, before the #1416 changes below.

| After opening | App process | WebKit processes | Total |
|---|---|---|---|
| 1k | 399 MB | 69 + 670 + 302 MB | 1,439 MB |
| 10k | 434 MB | 69 + 903 + 427 MB | 1,833 MB |
| 100k | 803 MB | 68 + 1,074 + 425 MB | 2,370 MB |
| 500k | 1,858 MB | 69 + 1,152 + 418 MB | 3,496 MB |

RSS counts shared pages in each process, so the total overstates unique memory.

## Memory attribution and fixes (#1416)

### What the 2.37 GB measured

The table above sums RSS over four processes after 20 open/go-up cycles of
every fixture in turn. RSS counts each shared library page once per process:
the idle app is about 1.38 GB of RSS but 0.53 GB of PSS (proportional set
size, `/proc/<pid>/smaps_rollup`). All figures below are PSS unless stated.

### Where it went (before: v1.14.0, `6bbc0ba8`)

`perf-real-app.mjs --scenarios memory` samples every process after a 15 s
settle: idle in the small fixture root, with a folder open, and after going
back up to the root, for four open/away cycles per folder (100k, then 500k).
Medians of n = 3 sessions, MB:

| Sample | App (Rust + WebKit UI) | Web content (shown) | Web content (parked warm window) | Network | Total |
|---|---|---|---|---|---|
| Idle in the fixture root | 170 | 203 | 129 | 26 | 528 |
| 100k open (1st) | 261 | 294 | 128 | 26 | 706 |
| Back in the root (1st) | 261 | 295 | 128 | 26 | 709 |
| Back in the root (4th), after JS collection | 378 | 231 | 128 | 26 | 763 |
| 500k open (4th), after JS collection | 877 | 554 | 128 | 26 | 1,586 |
| Back in the root (4th), after JS collection | 877 | 239 | 128 | 26 | 1,272 |

"After JS collection" follows in-page allocation pressure that makes
JavaScriptCore run full collections (the release WebView exposes no GC to the
runner); without it the web process keeps garbage until something allocates.

Three things held the memory:

1. **App process, glibc allocator retention (the leak-like part).** Its
   anonymous memory grew 30-90 MB with every 100k open and 55-234 MB with
   every 500k open, and none came back after navigating away (62 MB idle,
   770 MB after the 500k cycles). The per-mapping breakdown put it in glibc's
   non-main arenas (unnamed mappings aligned to 64 MiB): 678-817 MB of them
   after 20 opens of 500k. A listing allocates hundreds of MB briefly on
   rayon/blocking-pool threads; glibc keeps freed memory in each thread's
   arena, and its dynamic mmap threshold moves multi-MB buffers (scan
   vectors, the encoded reply) into those arenas after the first large free.
   Diagnosis: `MALLOC_ARENA_MAX=1` stopped the growth; capping arenas at 2 or
   4 also did, but slowed opening 100k by about 40% and 24% (lock contention), so it
   is not the fix.
2. **Web process, per-entry projections nobody read (working set).** Live
   JavaScriptCore heap of the flat listing pipeline, measured with
   `scripts/perf-listing-heap.mjs` (full collections in WebKitGTK's own `jsc`
   shell): 499 B/entry at 100k, 541 B/entry at 500k. 232 B/entry is the entry
   model itself; 141-183 B/entry was a placement map with an object per entry
   plus a second path→index map that no production code read, and 109 B/entry
   was row objects each carrying their own key string.
3. **Web process, uncollected garbage (not a leak).** After navigating away,
   web-content memory stayed up until allocation pressure; then it returned
   to within 20-40 MB of idle in every run, before and after the changes.

Not attributable to listings, and unchanged: the idle web-content process
(~200 MB), the parked warm window used for fast new windows (~130 MB) and the
network process (~26 MB).

### Changes

- `src-tauri/src/memory_release.rs`: at startup, fix glibc's mmap and trim
  thresholds at its own 128 KiB defaults (disabling the dynamic raise), and
  after a listing of 10k+ entries is encoded (and once more at the next
  listing, after the reply has been delivered) call `malloc_trim(0)`.
  Linux/glibc only; a no-op elsewhere (macOS and Windows were not measured).
  Each alone left about 2-3× as much in the app process as both together
  (app anonymous memory after 20 opens of 100k: 220-264 MB with trimming
  alone, 135 MB with fixed thresholds alone, 84-91 MB with both; 314-346 MB
  before).
- `domain/folder-peek-flat.ts`: a flat listing answers placement lookups from
  a path set built on first use, the unused path→index map is gone, and flat
  rows keep their constant fields on the prototype. `resolveFileCursor` no
  longer hashes every path against an empty selection.
- `domain/file.ts`: `sortEntries` lowercases each name once instead of on
  every comparison (100k name sort in `jsc`: ~200 → ~110 ms).

### After (same method, same machine)

Medians of n = 3 sessions, MB:

| Sample | App | Web content (shown) | Parked window | Network | Total | Before |
|---|---|---|---|---|---|---|
| Idle in the fixture root | 171 | 203 | 131 | 26 | 533 | 528 |
| 100k open (1st) | 194 | 276 | 130 | 26 | 626 | 706 |
| Back in the root (1st) | 168 | 283 | 130 | 26 | 608 | 709 |
| Back in the root (4th), after JS collection | 170 | 235 | 130 | 26 | 562 | 763 |
| 500k open (4th), after JS collection | 286 | 469 | 130 | 26 | 916 | 1,586 |
| Back in the root (4th), after JS collection | 170 | 242 | 130 | 26 | 568 | 1,272 |

Retained after navigating away (total PSS minus idle): 100k 23-32 MB (before
184-247 MB), 500k 33-38 MB (before 724-776 MB). The app process is back at
its idle size after every cycle. Live JavaScriptCore heap per listed entry:
317 B (before 499-541 B), 30 MB for 100k entries.

The #983 metric (RSS after the 20th open, 1k → 100k → 500k in one session,
n = 2 sessions each):

| After opening | Before: total RSS / PSS | After: total RSS / PSS |
|---|---|---|
| 100k | 2,150-2,182 / 1,289-1,322 MB | 1,859-1,862 / 996-1,000 MB |
| 500k | 2,675-2,874 / 1,815-2,013 MB | 1,976-2,004 / 1,112-1,141 MB |

Most of what remains in that metric is the web-content process (634-711 MB
PSS), sampled right after the 20th open: uncollected garbage from 20
listings, which the memory scenario's collection step shows is not retained.

Folder-open time, same runner (`--scenarios open`, n = 20 per run, complete
median / p95):

| Folder | Before | After |
|---|---|---|
| 100k, full fixture set, 2 runs each | 251 / 266, 249 / 285 ms | 261 / 281, 262 / 284 ms |
| 100k only, 3 interleaved run pairs | 227 / 263, 236 / 260, 232 / 259 ms | 242 / 257, 243 / 278, 232 / 272 ms |
| 500k, 2 runs each | 1,578 / 1,627, 1,499 / 1,587 ms | 1,312 / 1,352, 1,303 / 1,344 ms |

At 100k the after-medians are 0-15 ms higher; one binary run six times in
the same session spread over 232-242 ms, so a difference below about
10 ms is not resolved by this method. 500k opens are 13-17% faster (smaller
projections and the cheaper sort).

Conditions: 2026-10-27, same machine as above; base `6bbc0ba8` (v1.14.0) vs
this change, both release builds with `custom-protocol`. 1-minute load
average 2.0-33.2 during the "before" memory sessions (other work on the
desktop; memory is far less load-sensitive than time) and 0.8-5.0 during the
"after" ones, 1.5-5.5 for the timing runs.

### Budgets

- `bun run perf:listing-heap`: fails above 380 B/entry of live JS heap for a
  100k flat listing (now 352 with the #1417 binary reply, 317 after #1416; before 499). Needs the WebKitGTK `jsc` shell.
- `perf-real-app.mjs --scenarios memory --memory-cycles 4 --gc-pressure-mb 4096
  --max-retained-mb 80 --max-live-bytes-per-entry 1600`: fails when total PSS
  after navigating away exceeds idle by more than 80 MB, or the open folder
  costs more than 1,600 B/entry (now 23-38 MB and 742-1,151 B/entry; before
  184-776 MB and 2,178-3,244 B/entry). The live-per-entry figure is noisier
  than the `jsc` one: collection by allocation pressure is not exact.

## Folder-open pipeline (#1417)

### Where an open spends its time

`perf-real-app.mjs` now reports `phasesMs` per scenario: the native spans of
each load (logged by the app when `TAURI_EXPLORER_LISTING_TIMING=1`, which the
runner sets) joined with the frontend load trace. `ipcAndParse` is the native
round trip minus the native total: carrying the reply to the webview and
parsing it. `project` is filtering, sorting and peek projection of the new
listing; `settledToRows` the time from the load settling to the rows being in
the DOM; `rowsToFrames` the two animation frames after that.

Medians, ms, release build, same machine and runner as above (n = 10 per
round, 2 interleaved rounds per binary; first round shown, the second agreed
within 10 ms at 100k and 20 ms at 500k):

| Phase | 100k before | 100k after | 500k before | 500k after |
|---|---|---|---|---|
| Rust: watch registration | 9 | 0 | 45 | 44 |
| Rust: read directory | 52 | 53 | 244 | 236 |
| Rust: entry metadata | 24 | 24 | 110 | 111 |
| Rust: sort | 25 | 14 | 161 | 91 |
| Rust: encode reply | 21 | 16 | 115 | 70 |
| Rust total | 131 | 105 | 674 | 550 |
| Reply to webview + parse (`ipcAndParse`) | 58 | 22 | 376 | 98 |
| Decode | 3 | 7 | 11 | 31 |
| Project (filter, sort, peek) | 14 | 16 | 83 | 100 |
| Settled → rows in DOM | 25 | 21 | 98 | 55 |
| Rows → two frames | 17 | 15 | 27 | 27 |
| **Open, complete** | **260** | **194** | **1,285** | **873** |

`ipcAndParse` before included Tauri dropping the returned listing after
encoding it and before sending it: 1.5 M heap strings at 500k, 134-146 ms
(11-21 ms at 100k), measured by timing that drop in an instrumented build.
The 100k watch-registration figure is mostly the first open of a run (its
p95 is 9 ms in both builds). Phases are medians of their own, so they do not
sum exactly to the open time.

### Changes

- `src-tauri/src/files/listing_reaper.rs`: the last owner of a listing of 10k+
  entries is freed on a background thread (bounded queue of 4; a full queue
  frees inline), which then returns the pages to the OS through
  `memory_release`. Shared listings (still cached) free nothing and stay inline.
- Binary reply (`directory_wire.rs`, `api/directory-wire.ts`): listings are
  returned as raw bytes (`tauri::ipc::Response`): a JSON header, fixed-width
  little-endian columns and UTF-8 string columns, each decoded with one
  `TextDecoder` call and sliced per row. ASCII and non-ASCII names are
  separate columns. The format is documented in `directory_wire.rs`; Rust and
  TypeScript encoders are byte-identical against
  `tests/fixtures/directory-wire.json`.
- `dir_listing.rs`: `par_sort_by_cached_key` from 8,192 entries (same order as
  the stable sequential sort).
- Frontend: `getSelectedEntries` copies the reactive selection once and
  compares path lengths before hashing (a decoded path is a prefix + name
  rope that hashing flattens); `pruneExpanded` skips its scan when no peek is
  remembered; `isSystemHidden` checks name length before lowercasing.

### Before and after

End-to-end, complete median / p95 in ms, two interleaved rounds of n = 10
per binary (round 1, round 2). Before: base of this change (`a2d387d6`, the
#1416 branch) plus the timing instrumentation only.

| Operation | Before | After |
|---|---|---|
| Open 10k | 70 / 88, 55 / 58 | 54 / 60, 51 / 55 |
| Open 100k | 260 / 276, 250 / 279 | 194 / 265, 188 / 232 |
| Open 500k | 1,285 / 1,355, 1,266 / 1,339 | 873 / 930, 856 / 892 |
| 100k: enter folder | 252 / 319, 276 / 305 | 188 / 197, 185 / 251 |
| 100k: go up | 239 / 280, 239 / 276 | 187 / 193, 189 / 242 |
| 100k: back | 237 / 277, 238 / 326 | 186 / 193, 187 / 259 |
| 100k: forward | 243 / 263, 244 / 295 | 186 / 191, 186 / 287 |
| 100k: sort Name → Size | 113 / 129, 110 / 129 | 110 / 130, 107 / 207 |
| 100k: sort Size → Name | 66 / 73, 65 / 71 | 75 / 83, 76 / 112 |
| 100k: scroll frame interval | 17 | 17 |

Sort changes are frontend-only work (`sortEntries` and re-rendering) that
this change does not touch; their differences are within run-to-run spread
(the Size → Name pair was measured at the most loaded point of each round).

Memory (`--scenarios memory`, same flags as the #1416 budget, one session
each, PSS): the fixed build passed the budget, retaining 23 MB (100k) and
20 MB (500k) after navigating away, live 660 and 471 B/entry. The app
process with the 500k folder open measured 169 MB against 277-283 MB before:
the reply no longer keeps a second copy of the entries alive while it is sent.
The base session failed its own 500k budget (377 MB retained, sampled after
the allocation-pressure step raised web-content PSS from 246 to 583 MB), so
its 500k figures are not a reliable before value; the 100k ones (33 MB,
1,092 B/entry) are in line with #1416's. `bun run perf:listing-heap`:
352 B/entry (was 317; budget 380). The decoded entry costs 267 B against 232
B from JSON in `jsc`, because `jsc` counts a substring of a decoded column
(~40 B) above a JSON-parsed string (~23 B); the real app's live figure above
fell rather than rose.

Conditions: 2026-10-28, same machine; 1-minute load average 1.9-4.5 during
the timing rounds (desktop in use).

## Reproducing

All commands run from the repository root. Build commands are niced so a
desktop stays usable; do not nice the measured runs.

```bash
# 1. Fixtures: flat folders of 1k/10k/100k/500k entries in a temp dir outside the repo
#    (sparse files, ~30 MB on disk in total; ~20% are dot-files, hidden by default)
node scripts/perf-fixtures.mjs create --root /tmp/te-perf-fixtures

# 2. Release binary with the embedded frontend
nice -n 19 bun run build
(cd src-tauri && nice -n 19 cargo build --release --features tauri/custom-protocol)

# 3. End-to-end runner (Linux; needs Xvfb, dbus-run-session and WebKitWebDriver,
#    e.g. Debian/Ubuntu `xvfb dbus-x11 webkit2gtk-driver`, Arch `xorg-server-xvfb webkit2gtk-4.1`)
env -u WAYLAND_DISPLAY GDK_BACKEND=x11 \
  xvfb-run -a --server-args="-screen 0 1920x1080x24" dbus-run-session -- \
  node scripts/perf-real-app.mjs --fixtures /tmp/te-perf-fixtures \
    --binary src-tauri/target/release/tauri-explorer --runs 20 --out e2e.json
#    Per-phase breakdown (#1417): every open/nav scenario carries `phasesMs`; the
#    runner sets TAURI_EXPLORER_LISTING_TIMING=1 so the app logs its native spans.
#    `--scenarios open --open-sizes 100k,500k` limits a run to those opens.

#    Memory attribution and budget (#1416): --scenarios memory, see "Budgets"
env -u WAYLAND_DISPLAY GDK_BACKEND=x11 \
  xvfb-run -a --server-args="-screen 0 1920x1080x24" dbus-run-session -- \
  node scripts/perf-real-app.mjs --fixtures /tmp/te-perf-fixtures \
    --binary src-tauri/target/release/tauri-explorer --scenarios memory \
    --memory-sizes 100k,500k --memory-cycles 4 --settle-ms 15000 --gc-pressure-mb 4096 \
    --max-retained-mb 80 --max-live-bytes-per-entry 1600 --out memory.json
#    JS heap of the listing pipeline (no app build needed; WebKitGTK's jsc shell)
bun run perf:listing-heap

# 4. Rust layer (compile niced, then run; the env var adds the fixture folders)
(cd src-tauri && nice -n 19 cargo bench --no-run && \
  TAURI_EXPLORER_BENCH_FIXTURES=/tmp/te-perf-fixtures cargo bench --bench scan_directory_parallel --bench sort_entries)
#    median/p95 come from target/criterion/<bench>/new/sample.json (times[i] / iters[i])

# 5. Frontend layer (repeat 5×; --silent=false shows the per-benchmark lines)
bunx vitest run -c vitest.perf.config.ts --silent=false
#    `bun run bench:render` runs only tests/perf/render.bench.ts

# 6. Clean up
node scripts/perf-fixtures.mjs remove --root /tmp/te-perf-fixtures
```

### How the end-to-end runner works

`scripts/perf-real-app.mjs` launches the unmodified release binary with the
fixture root as its start folder and a fresh private XDG config/data/cache/state
profile, so no desktop settings, history or caches leak in. It sets only
`TAURI_WEBVIEW_AUTOMATION=true` (lets WebKitGTK accept an automation session)
and `WEBKIT_INSPECTOR_SERVER`, then attaches WebKitWebDriver in `--target` mode.
(The release binary forks into the background on Linux, so a driver that
launches the binary itself, such as tauri-driver, loses track of it.)

For each operation the runner injects one script into the page that arms a
`MutationObserver`, dispatches the input event (a `dblclick` on the folder's
row, or a `click` on the toolbar's Back/Forward/Up button or a column header),
and records `performance.now()` deltas:

- **first rows**: the status bar path is the destination and a row whose path
  is directly inside it is in the DOM;
- **complete**: the status bar shows the destination's full visible entry count;
- **sort**: the clicked column header is active and the first ten rows changed;

each followed by two `requestAnimationFrame` callbacks, a paint opportunity.
That is not proof that the compositor presented the pixels, and the time
before the event reaches the page (OS input latency) is not included. The
JSON output also has `domCompleteMs`, the time the DOM condition was met
without the frame wait: 14–31 ms lower in these runs. WebKit's
`performance.now()` has 1 ms resolution here.

The fixtures (`scripts/perf-fixtures.mjs`) are deterministic: mixed-case,
numeric, spaced, dotted and non-ASCII names of 7–56 characters, fifteen
extensions or none (no images or videos, so no thumbnail work), logical sizes from 0 B
to 64 MiB (sparse, so the listing reports them but the disk does not store
them) and modification times spread over five years. Each folder contains one
subdirectory, `000-subdir`, used as the start point for go-up, back and
forward.
