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
