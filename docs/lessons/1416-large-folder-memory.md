# #1416 — large-folder memory: what the 2.37 GB was, and what held it

**Symptom.** `docs/performance.md` (#983) reported 2.37 GB resident after the
100k-entry fixture and 3.50 GB after 500k.

**What that number measured.** The sum of RSS over the app process and its
WebKit children after 20 open/go-up cycles of every fixture in sequence (1k,
10k, 100k, 500k) in one session. RSS counts shared library pages once per
process; PSS of the same idle app is about 490 MB against 1.33 GB of RSS. Use
PSS (`/proc/<pid>/smaps_rollup`) for any per-process memory claim, and say how
many folders were opened before the sample.

**Root causes (measured, release build, `--scenarios memory`).**

1. *glibc retained the app process's transient listing memory.* A large
   listing allocates hundreds of MB for a moment on rayon/blocking-pool
   threads. glibc keeps each thread's freed memory in that thread's arena (up
   to 8 per core), and its dynamic mmap threshold rises after the first large
   free, so later multi-MB buffers (scan vectors, the encoded reply) come from
   arena heaps whose free tops stay resident (up to 64 MiB each). App
   anonymous memory grew 30-90 MB per 100k open and never came back, even
   after navigating away. Diagnosis: `MALLOC_ARENA_MAX=1` made it plateau,
   but capping arenas (2 or 4) cost about 24-40% folder-open time through lock
   contention, so it is not the fix. The fix (`memory_release.rs`) fixes the
   mmap/trim thresholds at glibc's defaults at startup and calls
   `malloc_trim(0)` after large listings; either alone left 2-3× as much.
   The runner's `anonByAllocator` breakdown attributes this directly:
   glibc's non-main heaps are unnamed mappings aligned to 64 MiB, WebKit's
   allocator is `[anon:WKFastMalloc]`.
2. *Per-entry projections nobody read.* The flat (no peek open) projection
   built a placement object plus two map slots per entry (`meta`, and an
   `indices` map no production code read) and a row object with its own key
   string — about 220 B/entry of a ~520 B/entry live listing in
   JavaScriptCore. Flat placement is now answered from a lazily built path set,
   and flat rows keep constant fields on the prototype.
3. *Not a leak:* the web process "retained" memory after navigating away is
   uncollected garbage. JavaScriptCore collects on allocation, so an idle page
   keeps it until something allocates; after allocation pressure it returns to
   within 20-40 MB of idle. A sample right after navigating away is not evidence
   of retention.

**Result.** Retained after navigating away fell from 184-776 MB to 23-38 MB
(total PSS over idle); numbers and method in `docs/performance.md`.

**Gotchas.**

- An empty `Set.has(rope)` still flattens the rope: `resolveFileCursor`
  scanned every entry against an empty selection on each recompute.
- Garbage that dies young does not make JSC run a full collection; the runner's
  pressure keeps a 128 MB sliding window so the garbage reaches the old
  generation. Even so, a single pressure sample is noisy; trust the
  `perf-listing-heap` numbers for the JS live set.
- `WEBKIT_INSPECTOR_HTTP_SERVER` cannot be combined with
  `WEBKIT_INSPECTOR_SERVER` (the WebDriver attach socket never listens), so no
  inspector heap snapshot is available through the perf runner. The `jsc`
  shell of the same WebKitGTK build (`/usr/lib/webkit2gtk-4.1/jsc`) has
  `fullGC()` and `gcHeapSize()`, which is what `scripts/perf-listing-heap.mjs`
  uses.
- `LD_PRELOAD` of mimalloc made the app *larger* (it replaces malloc for GTK and
  WebKit too); it is not a substitute for fixing retention.
