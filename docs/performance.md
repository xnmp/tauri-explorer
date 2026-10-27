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
rendering) was not broken down further: there is no per-phase timing for
ordinary loads (the slow-load watchdog only records loads over 5 s).

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

### Memory (end-to-end run)

Resident set size after the 20th open of each folder, same session (so later
rows include whatever earlier folders left behind). The app runs a main process
plus a WebKit network process and two WebKit web-content processes.

| After opening | App process | WebKit processes | Total |
|---|---|---|---|
| 1k | 399 MB | 69 + 670 + 302 MB | 1,439 MB |
| 10k | 434 MB | 69 + 903 + 427 MB | 1,833 MB |
| 100k | 803 MB | 68 + 1,074 + 425 MB | 2,370 MB |
| 500k | 1,858 MB | 69 + 1,152 + 418 MB | 3,496 MB |

RSS counts shared pages in each process, so the total overstates unique memory.

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
