# Why the DnD suite missed #1217

Audit date: 2026-10-17. Baseline: `origin/dev` at
`8fee77c8465f844e9e112c096736784acbb83d50`. The audit checkout has that exact
merge base; the #1216 fix is a later commit. Native reproduction used a private
Xvfb display, private D-Bus session and isolated XDG profile; no user-desktop
input was used.

## Finding

The suite checked downstream drop policy after assuming a usable native drag
existed. The failure happened while creating that drag: Linux HTML5 `dragstart`
started an explicit GTK plugin context, then WebKit created another context for
the same held mouse button. The explicit context failed, and its completion
correctly retired the provenance that the surviving browser gesture needed.
Folder hover could succeed while releasing the button performed no move.

This was an integration coverage gap across WebKit, GTK, the native source
completion channel and receiver identity. Increasing the policy table's
Cartesian dimensions would not make GTK create or compete those contexts.
The completion fence is necessary to keep unrelated external gestures from
borrowing stale selection; weakening it would conceal the ownership error.

## Evidence that the existing suite was green on the broken source

An independent copy was extracted with `git archive origin/dev` into `/tmp`,
using unchanged baseline `src/`, `tests/`, native callback sources and configs.
It shared installed dependencies only. Running:

```sh
bunx vitest run tests/composables/drop-policy-differential.test.ts \
  tests/composables/file-drag-lifecycle.test.ts --maxWorkers=1 --reporter=dot
```

produced **2 files passed; 22,683 tests passed; 123 skipped; 13.19 seconds**.
The 123 skips are platform-selected rows in these cross-platform fixtures;
there was no omitted real-GTK case hiding among them. The local transcript is
`/tmp/issue1217-audit-baseline-tests.log` (temporary diagnostic, not durable proof).

The native investigator separately reproduced no move using held-button XTest
input against the baseline app. Rejecting only the redundant plugin GTK start
before it created a second source allowed WebKit's original drag to deliver
Enter/Over/Drop and move the real file. Changing the plugin's button argument
from 256 to 1 did not fix the failure. These controls separate the competing
source from a wrong button number or a missing frontend folder handler.
See [the implementation lesson](../lessons/1217-linux-html5-native-drag-ownership.md)
for the retained reproduction and fix evidence.

## What each layer actually proves

| Coverage | Actual boundary exercised | Boundary bypassed |
| --- | --- | --- |
| `tests/composables/drop-policy-differential.test.ts` | Production frontend source adapters, identity, modality, routing and exactly-once calls against an independent policy table | `start_file_drag`, OS session creation, GTK selection transfer, actual receiver payload production and disk mutations |
| `tests/composables/file-drag-lifecycle.test.ts` | Frontend source/receiver lifecycle under chosen IPC replies and manually delivered events | Real native context identity and whether those events can actually occur |
| `tests/helpers/platform-drag-intent.ts` | Compiles actual production callback expressions and GTK Drop body with inert adapters | WebKit HTML5 startup, `drag::start_drag`, GDK context allocation, native signal ordering and real selection data |
| `src-tauri/test_support/native_file_drag.rs` | Actual registry and completion routines, including immediate retirement before delayed notification | A live WebKit widget creating a competing GTK context |
| `e2e/file-drag-carrier.spec.ts` | Browser-generated drag from the real row; ordered plugin delivery; stripped HTML carrier | Tauri/GTK source creation and filesystem transfer |
| `e2e/plugin-file-drop.spec.ts` | Real DOM handlers, plugin ownership and mock filesystem outcomes after a stubbed start rejection | Native-start acceptance followed by platform cancellation and a surviving WebKit source |
| Pre-fix `e2e-tauri/specs/` | Native file operations, watchers, clipboard, resize/marquee/PDF input and other contracts | No actual file-row drag-to-folder transfer case existed |

### The decisive fixture assumptions

In `drop-policy-differential.test.ts`:

- The top-level `vi.mock("@tauri-apps/api/core", ...)` routes
  `start_file_drag` to `io.start`; `beforeEach` defaults that call to a resolved
  Promise. There is no GTK drag source behind the acknowledgement.
- `native(...)` fabricates a payload containing `[sourcePath]`, the chosen
  source identity, modifier and observation time, then calls the registered
  listener directly. `deliverNative()` generally feeds Enter and Drop
  consecutively. The fixture guarantees the very delivery that failed.
- `transfer()` is a Map-backed DataTransfer. Stripped visibility projects MIME
  values in JavaScript; it does not perform WebKit-to-GTK URI serialization.
- `native-rejected` makes the start Promise reject. The observed failure was
  different: native startup accepted context A, A then cancelled, and the same
  physical gesture still had browser context B. `native-accepted` did not model
  which context its successful acknowledgement referred to. Testing both
  accepted/rejected startup therefore did not exhaust native ownership states.
- Standard rows send native `Cancelled` completion during `afterEach`, after
  the asserted outcome. Temporal rows do explicitly exercise completion
  races, but they begin from a test-created native lease and selected payloads;
  none creates plugin context A and automatic WebKit context B for one drag.
- `moveFiles` and `copyFiles` record outcomes and arguments. These are useful
  policy contracts, but a recorded `"move"` is not proof of a real moved file.

### A second native gap: receiver action negotiation

Adopting WebKit's sole source exposed another failure that the same matrix could
not see. The Miller native probe reached an accepted source and receiver hover,
but WebKit negotiated GTK Move and then None at release, so GTK never emitted
Drop. Owning source lifetime alone therefore did not complete Miller transfer.
The filesystem receiver now acknowledges supported Copy transport and consumes
its GTK motion; the application still applies Move/Modifier domain policy.
Copy acknowledgment is deliberately separate from deciding whether Explorer
moves its own files.

The actual accepted-source probe before negotiation ownership failed
(`/tmp/issue1217-final3-miller.log`, with the native status trace showing
Move `4` → None `0`). The same probe after the fix moved the directory
(`/tmp/issue1217-final4-miller.log`, `RESULT false true`), and Ctrl-copy retained
the original (`/tmp/issue1217-final-miller-copy.log`, `RESULT true true`). These
are observed transport outcomes, not new expectations added to a policy oracle.

The differential fixture always injects its chosen Drop. The callback extractor
compiles the GTK Drop body after assuming it was invoked. Neither exercises GTK
`drag-motion` ownership, action negotiation, or the decision to emit Drop at
all. This is a second reason that “all drop outcomes match the matrix” could be
true while releasing a highlighted real folder did nothing.

Review also exposed a delayed-URI-reply boundary: the first receiver motion must
pin the source snapshot before a pooled GTK window handle can be reused or an
IPC callback can replace its association. The fix retains actual object identity
and the first motion's context token. The Rust regression
`delayed_uri_reply_keeps_the_first_receiver_motion_token_after_ipc_window_reuse`
and the production observer callback fixture cover that sequencing contract.
They complement the filesystem native smoke; they do not replace it.

The independent `devDropPolicy` / `branchDropPolicy` table in
`tests/helpers/drop-policy.ts` is explicitly hand-audited against baseline
`773eb55a`; it does not execute old and new native applications differentially.
Independence of expected policy prevents a shared routing bug in the oracle,
but cannot validate transport assumptions supplied by the runner.

A related gap is visible in the old browser test
`e2e/breadcrumb-drop.spec.ts`: its test title says segments have drag handlers,
but the only assertion is that breadcrumb elements exist. This particular test
cannot establish any drop outcome. The separate rejected-start cases in
`plugin-file-drop.spec.ts` do check source/destination mock listings and should
be retained; the problem is their explicitly simulated transport boundary.

## Regression window: evidence versus attribution

| Date / commit | Change | Relevance |
| --- | --- | --- |
| 2026-04-19 `06f3e144` | Linux listing HTML5 startup calls `startExternalDrag(paths)` | Two potential source creators predate the reported recent regression |
| 2026-09-25 `20b1a478` | Historical v1.9.1 snapshot, including its Cargo.lock and frontend source | Same native failure reproduced; rejecting only the duplicate source restores a real move |
| 2026-10-12 `2793fcbf` (#1098) | Adds `native_file_drag.rs`, native source provenance, synchronous completion retirement, completion channel/lease handling and shared HTML5 source lifecycle; GTK source completion moves to `dnd-finished` | Changes retirement semantics, but its parent also fails the real gesture; not the introducing commit established by reproduction |
| 2026-10-15 `1a8c569a` (#1159) | Quick Access dragend-only late-rejection behavior | Sidebar fallback, not a demonstrated introduction of ordinary folder failure |
| 2026-10-16 `41e93cd2` (#1187) | Adds GNOME Wayland modifier snapshot capture and source intent lifetime | Does not introduce the second native source; cannot explain the baseline X11 reproduction by its Wayland-only path |
| 2026-10-16 `902120bf` (#1190) | Video audio change | No causal DnD source change found |

The initial source-history hypothesis blamed #1098's added completion fence:
before that commit the external-drag wrapper invoked the plugin without
connecting its result to Explorer source retirement. Native testing falsified
that attribution. An exact archive of parent `5dee86509c5b285691a42700ae40edae05cc892e`
was built with its matching frontend and `tauri/custom-protocol,e2e-hooks`.
The same held-button XTest gesture on private display `:128` left the source
present and the destination absent (`RESULT true false`). The app, driver and
WebKit helper environments were checked before input; all used the private
display, profile and D-Bus session, including activated portal helpers. The
baseline delivered no useful Drop. With only the redundant GTK start rejected
by an LD_PRELOAD control, that exact same old binary moved the file
(`RESULT false true`). Thus #1098 is **REFUTED as a necessary introduction of
this failure**, and the earlier failure is attributable to the same competing
source mechanism rather than merely an unrelated old regression.

Local historical evidence: `/tmp/issue1217-before-1098-probe.log`,
`/tmp/issue1217-before-1098-driver.log`,
`/tmp/issue1217-before-1098-control-probe.log`,
`/tmp/issue1217-before-1098-control-driver.log` and
`/tmp/issue1217-before-1098-probe.png`. The exact copied binary is
`/tmp/issue1217-before-1098-binary`. The source snapshot was not modified;
only the probe's selector was adapted because the old single-pane UI does not
render an `.active` class.

A second historical build, `20b1a4787dd3285aac6aacc409212392880456db`
(2026-09-25, v1.9.1), also failed the same isolated real-input fixture
(`RESULT true false`). The duplicate-source rejection control again moved the
file (`RESULT false true`); its native trace shows the plugin's button-256 begin
rejected and WebKit's button-1 begin accepted. Logs:
`/tmp/issue1217-sep25-probe.log`,
`/tmp/issue1217-sep25-control-probe.log` and
`/tmp/issue1217-sep25-control-driver.log`. The copied binary is
`/tmp/issue1217-sep25-binary`. No further historical builds were needed.

All three source versions ran against the **same current host runtime**:
WebKitGTK **2.54.1** and GTK **3.24.52**, verified using `pkg-config` in the native
host environment. `ldd` on the Sep 25, pre-#1098 and current copied binaries
resolved the same WebKitGTK, GTK and JavaScriptCore shared libraries:
`libwebkit2gtk-4.1.so.0.24.4`, `libgtk-3.so.0.2420.32` and
`libjavascriptcoregtk-4.1.so.0.11.8`. Rust dependencies came from each snapshot's
Cargo.lock; historical frontend source was built using the installed frontend
toolchain. This reconstructs historical application code on today's platform,
not the historically installed runtime/dependency environment.

**Conclusion on onset:** a post-Sep-25 application change is not necessary to
produce this failure on the current host. The dual-source design exists in
older source, but its introduction date is not proof that users experienced the
failure then. A platform change or different usage could expose an old design
fault; neither explanation is established here. The actual first-bad application
or platform version remains unknown. Do not attribute it to #1098, #1187,
#1190, or April merely from source history.

## Why CI did not expose it

The native smoke workflow was capable of running a genuine Linux gesture:
`.github/workflows/e2e-tauri.yml` builds the embedded hook-enabled Tauri app,
then runs the default suite inside Xvfb/Openbox with an isolated session bus.
`e2e-tauri/wdio.conf.ts` discovers `./specs/**/*.spec.ts`, runs one instance at a
time and records per-test outcomes. Its only configuration exclusion is the
warm-window spec when warm priming is disabled. Before this fix there was no
file-drag transfer spec for that discovery to select. A green native smoke
therefore said nothing about source handoff.

There is no source evidence of a real file-DnD regression test being silently
skipped by a prerequisite gate. `gated-suites.ts` documents that WDIO can count
skipped files as passed and supports fail-on-missing prerequisites, but that
mechanism did not hide this absent case. Browser matrix expansion and optional
WebKit runs cannot substitute for GTK in an actual Tauri app. Playwright's
WebKit browser is not the complete embedded WebKitGTK/Tauri transport.

The limitation was already disclosed in
`docs/lessons/29-drop-policy-differential.md`: physical GTK delivery was not
exercised (around line 787), physical compositor/external drag acceptance
remained unverified (around line 1044), and browser/native reentry remained
unverified (around line 1073). These limits never became an acceptance gate for
changes to native source ownership. In addition, the pre-fix header of
`e2e/plugin-file-drop.spec.ts` claimed real OS delivery was covered by native
qualification even though the native file-transfer case did not exist. Coverage
ownership was assumed across layers without an executable outcome test. The
#1217 change corrects that browser header and replaces the breadcrumb existence
check with an actual drag-to-ancestor outcome, including source removal and
destination listing verification in Details, List and Tiles.

## Durable prevention

1. **Keep one mandatory native move smoke.** A real row drag onto a real folder
   must remove the source, preserve destination content, refresh the listing
   and expose the moved entry after navigation. Use trusted native input on the
   isolated Linux display; do not recover failed input by dispatching DOM
   `DragEvent`s or calling mutation IPC. Demonstrate that the same test fails on
   the pre-fix source and passes with the fix.
2. **Cover distinct native source paths selectively.** Add ordered multi-file
   selection and Miller source cases, plus native cancel/retry and owner removal.
   Native investigation already observed WebKit concatenating multiple URI-list
   entries into one exported native path; a Map-backed DataTransfer cannot catch
   this. Cross-window drag needs a real second webview, not just a second module
   import. Keep the comprehensive destination-policy matrix in Vitest instead
   of duplicating it into expensive native Cartesian suites.
3. **Test ownership at the native seam.** Unit-test actual native adoption,
   duplicate begin, completion-before-command-reply, drop-before-adoption and
   end/dispose-before-adoption. Assert registry outputs and allowed operations,
   retaining the security contract that completed sources cannot authorize
   unrelated external drops. A narrow platform adapter test should also fail
   if an HTML5 source starts a second plugin session.
4. **Make native admission explicit.** The Linux file-drag outcome spec belongs
   in ordinary native smoke discovery, without an optional feature/fixture gate.
   If additional input tools become required, install and validate them in that
   job; missing support must fail the dedicated acceptance check. Record actual
   test count/outcome and retain drag diagnostics on failure. A cancellation,
   unsupported pointer action or skipped spec cannot count as native acceptance.
5. **Keep environment claims bounded.** Xvfb proves GTK X11 source ownership,
   not GNOME Wayland modifier restoration or external file-manager behavior.
   Preserve the Wayland wire-protocol tests and require a separate admitted
   compositor check when claiming those flows. This does not require automating
   the user's active desktop.
6. **Correct coverage labels.** Describe browser carrier tests as DOM/plugin
   admission tests. Link to the actual native outcome spec for OS delivery.
   Prefer a small test that moves one real file to another hundred synthetic
   platform rows whenever the changed code owns native transport.

## New regression review

The new Linux `e2e-tauri/specs/file-drag.spec.ts` uses the shared
`e2e-tauri/helpers/native-drag.py` XTest helper. It holds the real primary button
while native handoff runs, after checking that the display is Xvfb, the active
window belongs to the automation app, and the app, driver, WebKit and portal
helpers share the private display, bus and XDG profile. No synthetic DOM Drop or
file mutation command repairs a failed gesture.

The spec has three outcome cases: a listing move of two selected files with
space/hash and non-ASCII names; a Miller directory move; and a Miller Ctrl-copy
that retains its source. They verify actual source/destination state, exact
file contents and visible listing refresh/navigation. They require the accepted
native decision to match the exact started session, and no DOM Drop, preventing
a browser-only fallback from masking failure of the native path. Ordinary Linux
smoke discovery selects this spec; Windows is explicitly outside this
GTK-specific regression.

**Exact baseline RED is confirmed.** The committed spec ran through the real
WDIO config against the isolated, hook-enabled `8fee77c8` binary, selected via
the production runner's SHA-256-verified build-manifest path. Native input was
admitted and executed in all three cases. The listing failed with
“drop highlighted its folder but did not move the file”; both Miller cases
failed with “Miller native drag did not apply the requested move/copy policy.”
These were filesystem outcome failures, not input/setup errors. Result:
**0 passed, 3 failed**, 40.4 seconds of tests / 43-second run. An earlier
single-case run and the native investigator's independent run obtained the
same listing failure on separate private displays.

Baseline evidence: `/tmp/issue1217-origin-baseline-native-spec-final3.log`,
`/tmp/issue1217-origin-baseline-manifest.json` and
`/tmp/issue1217-origin-baseline/tauri-explorer` (SHA-256
`e99e18803a28bec1389342d0d320d18ddf769d0a5a9a45b3fe6a58e88423534d`).
The launcher `/tmp/issue1217-origin-baseline-native-spec.sh` uses the real
`wdio.conf.ts` and the committed spec unchanged, with separate ports and a
private profile established before D-Bus starts.

**Final fixed-binary GREEN is confirmed:** the same three-case committed
native spec passed on the final-11 binary: **3 passed in 10.4 seconds**.
Evidence: `/tmp/issue1217-native-final11-and-terminal-diagnostic.log`. Thus the
native regression is demonstrated red on exact `8fee77c8` and green on the fix,
with real filesystem/UI outcomes, the exact accepted source session and no DOM
Drop fallback. Independent review confirmed 46 native contracts and 9 compiled
production callback tests, with no remaining blockers in the reviewed scope.

The native GUI evidence is GTK X11 on private Xvfb. The GNOME Wayland observer
has static/source analysis, native payload/lifetime contracts and a private
wire-protocol compositor test; actual physical GNOME mid-drag modifier behavior
remains **PLAUSIBLE / unverified**, and is not established by Xvfb or the policy
matrix. Cross-window and external-application drag interoperability likewise
need their own admitted native outcomes when claimed. Completion/owner-removal
and delayed callback contracts are covered at their importable native seams;
the three GUI cases do not independently exercise every such interleaving.
