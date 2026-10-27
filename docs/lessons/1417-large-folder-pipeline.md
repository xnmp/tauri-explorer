# #1417 — large-folder pipeline: where a 100k-500k open spent its time

**Symptom.** Opening the 100k fixture took ~250 ms and the 500k one ~1.25-1.65 s
(`docs/performance.md`), with no breakdown below "scan is ~37%".

**Measure first, per phase.** `TAURI_EXPLORER_LISTING_TIMING=1` makes the
native side log every closed span of a listing's load trace
(`Listing(timing) id=… us=phase:start+dur,…`), and `perf-real-app.mjs` joins
those lines with the frontend trace into `phasesMs` per scenario. Without that
join the IPC cost is invisible: it lives between the last native span and the
frontend's `decode` phase (`ipcAndParse`).

**Root causes (release build, 500k unless noted).**

1. *Tauri drops a command's return value after encoding it and before sending
   it.* A `DirectoryListing` of 500k entries owns 1.5M heap strings, mostly
   allocated by rayon threads' arenas; freeing them took 134-146 ms (11-21 ms at
   100k) while the encoded reply waited. Not visible in any span, only as a gap
   between "serialized" and the webview receiving bytes. `listing_reaper.rs`
   moves the last owner of a large listing to a background thread (bounded
   queue; full → inline) that also triggers `malloc_trim`. A shared `Arc`
   (cache still holding it) frees nothing and stays inline.
2. *JSON on both sides.* serde_json encode 115 ms + transfer + `JSON.parse`
   ≈ 370 ms. The binary TEL1 format (`directory_wire.rs` /
   `api/directory-wire.ts`) returns a raw `tauri::ipc::Response` (no JSON
   wrapping of the bytes), fixed-width columns, and UTF-8 string columns that
   the webview decodes with one `TextDecoder` call each and slices per row.
   ASCII and non-ASCII names are separate columns so one accented name does not
   make WebKit keep every name as a 16-bit string. Byte-identical
   encoders on both sides share `tests/fixtures/directory-wire.json`.
3. *Sort single-threaded*: `par_sort_by_cached_key` above 8,192 entries (same
   key, both stable, identical order).
4. *O(n) render-path scans that hashed every path.* With a shared path prefix
   the decoded `path` is a rope (`prefix + name`); `Set.has(path)` flattens it.
   `getSelectedEntries` ran over the whole listing for the status bar and
   inspector on every publish: copy the reactive set once, and compare lengths
   before hashing. Also `pruneExpanded` (no remembered peeks → no scan) and
   `isSystemHidden` (length gate before lowercasing).

**Not causes (ruled out by experiment).** `malloc_trim` timing (LD_PRELOAD
no-op), web heap state, the loading spinner, and refresh republishing (pane
refresh already reconciles unchanged listings without publishing).

**Gotchas.**
- `jsc`'s `gcHeapSize` counts substring cells (≈40 B) above JSON-parsed
  strings (≈23 B), so `perf:listing-heap` rose slightly per entry while the
  real app's PSS did not; check the end-to-end memory scenario, not only `jsc`.
- `explorer.svelte.ts` is on the file-size allowlist: instrumentation lines
  count against it.
- `build/` holds whatever the last `bun run build` produced; an
  `E2E_BROWSER_BUILD` bundle embedded in a release binary is not the shipping
  frontend. Rebuild plainly before `cargo build --release`.
