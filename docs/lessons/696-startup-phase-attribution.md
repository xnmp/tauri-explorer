# 696 — attributing cold startup before changing startup policy

## Attribute first; the residual is the evidence that you did

A phase decomposition is only trustworthy if it publishes what it *cannot*
explain. `parseAttributedMacStartupLog` correlates the Rust monotonic clock with
the webview's wall-clock time origin at exactly two boundaries (native window →
document boot, webview `ui-ready` → readiness IPC receipt) and puts the whole
remainder in `unattributedMs`. Never redistribute that residual across the named
phases: on both Linux profiles it came out at ±0.05 ms, which is what makes the
named phases believable in the first place.

Time before `main()` — `exec`, dyld, Launch Services — is outside every
in-process clock. Adding `process-entry-to-run` narrowed the hole to the
pre-`main` interval only; that last piece is measurable *only* from an external
launch recording, which is why the half-bounce verdict requires the interactive
runbook and can never be produced by the hosted log-only job.

## Two animation frames are not a frame

`ui-ready` fires after two `requestAnimationFrame` callbacks. That is a
readiness signal. It is not the compositor presenting pixels, and it is not a
Dock bounce. `qualifyHalfBounce` returns `unqualified` — never a pass — unless
every sample carries an externally observed functional frame and a verified
input outcome against a *measured* deadline.

## An independent "is it ready yet" regex will drift, silently

`waitForMacStartupProcess` had its own `parseMacStartupLog` matching
`Startup(native-ready):\s*app-run-to-ready=`, while the report was built by
`parseAttributedMacStartupLog`. When the readiness line gained `window=main`,
the predicate stopped matching the format the binary emits, so every
direct-process sample would have timed out at 30 s on a real Mac — and both
`macos-smoke.yml` startup steps use that branch. Nothing failed locally because
the unit fixtures still encoded the *old* string: the tests agreed with
themselves rather than with the binary. There is now one parser, the fixtures
are copied verbatim from a captured launch, and requiring the full attributed
marker set also closed a race where readiness could be declared before the
webview line had flushed.

## The residual must be bounded, or it becomes the hiding place

`unattributedMs = launchTotalMs − attributedMs` holds by construction, so on its
own it proves nothing. A wall-clock step, or a log file holding two runs
(first-occurrence regexes happily mix them), inflates one of the two
epoch-correlated phases while the residual quietly goes to −600 000 ms and every
named phase still reads as plausible. The parser now rejects a residual below
−5 ms. Likewise a duplicated webview marker moves time out of one phase and into
the next with a *zero* residual to show for it, so duplicates are rejected too —
and `app-ready` is latched at the source, because a navigation landing between
readiness and the second animation frame legitimately re-runs that effect.

## A missed measured deadline is a failed run

`report.passed` used to ignore `halfBounce`, so a run whose measured p95 missed
the supplied deadline still wrote `passed: true` and exited 0. `missed` now
becomes a run error. `unqualified` deliberately does not: no deadline, or
incomplete interactive evidence, claims nothing either way.

## Duplicate marks are a merge hazard, and the log will tell you

After merging #684, the startup log read
`commands-ready=147.0ms commands-ready=147.0ms settings-ready=196.0ms
settings-ready=196.0ms`: #684 had moved the marks into `startWindowSession`,
and the merge re-applied them on the page's readiness callbacks. The regex
parser silently takes the first match, so nothing failed — only reading a real
log caught it. `window-session` owns `mount`, `settings-ready` and
`commands-ready`; `+page.svelte` owns only `bundle-exec`, `list-ready` and
`app-ready`.

## Profiling the release binary on Linux: mind the detach fork

`main.rs` forks and `_exit(0)`s the parent on Linux release builds (not on
macOS) so the launching terminal is freed. A sampler that pipes stdout and waits
for process exit therefore gets an empty log and an immediate exit. Write the
run to a file the forked child inherits and poll the file for the readiness
marker instead of waiting on the spawned process.

`scripts/qualify-macos-startup.ts` refuses to run off macOS by design. A Linux
run of the same binary through the same parser is useful only for finding
platform-independent critical-path work; it is never evidence for a macOS
number or a half-bounce verdict.

## `scripts/` had no type-check target

`bun run check` covers `src/`, `check:e2e:tauri` covered `e2e-tauri/`, and
nothing covered `scripts/`. That is how the macOS qualifier came to pass a
`NativeBuildManifest` where `readVerifiedNativeBuildManifest` returns the
verified build *summary* — an error that would only surface on a Mac runner,
after a full release build. `scripts/qualify-macos-startup.ts` uses node
built-ins only, so it is now in the native tsconfig's `include` and fails
`check:e2e:tauri` like any other native file. Scripts that use Bun globals still
have no coverage.

## Measured shape (Linux proxy, not macOS)

Release profile, Arch Linux / WebKitGTK, 10 launches, p50: framework bring-up
(`nativeWindowMs` 186.7 + `frameworkNavigationMs` 120.0 + `documentBootMs`
104.0) is ~62% of a 660 ms launch; all required application work is 209 ms
(~32%); frame scheduling 37 ms; readiness IPC 2.3 ms. The debug profile gives
the same shape (61% / 31%). No application-owned phase was demonstrated to be a
bottleneck, so no startup logic was changed for performance.

## Do not pace an already materialized snapshot

The old directory command scanned and sorted every entry before returning its
first 100 entries, then broadcast the remainder in 100-entry batches with a
1 ms pause per batch. Fresh navigation kept `explorer.loading` true, and
`FileList` hid its rows until the stream completed. Intermediate batches did
not provide earlier visible rows; they added transport delay and repeated
reactive work. A naive per-request channel removed pacing but added another
completion failure: a failed send could leave an already-successful invocation
without a terminal callback.

Navigation and refresh now consume a single complete, fresh snapshot. The
existing cached `list_directory` command remains available for cached readers;
`list_directory_fresh` deliberately bypasses that cache for navigation and
watcher reconciliation. Observed navigation still acquires the watch before
scanning and transfers the lease only if its owner accepts the result.

The listing owner serializes scans, invalidates obsolete requests at enqueue,
skips stale queued work, and disposes late leases before teardown completes.
Cancellation is distinct from a filesystem error: a superseded refresh must
not navigate to its parent. Native scanning and an IPC response already in
flight remain non-cancellable; do not claim bounded navigation latency for
slow/unresponsive filesystems from local-directory measurements.

## Keep startup and interaction evidence separate

The Arch comparison uses alternating fresh release processes under Xvfb and
Openbox, with uncontrolled warm OS caches. Launch-to-native-readiness includes
pre-main time. WebKitGTK interaction qualification uses the matching 4.1
WebDriver on isolated ports. The Linux release launcher's detach fork prevents
WebDriver session creation; a test-only, exact-executable preload shim bypassed
that fork for the interaction experiment only. It was not used for startup
timing. RequestAnimationFrame gaps and DOM observations are diagnostic proxies,
not compositor-presented frame measurements or a macOS half-bounce verdict.
