# Architecture pressure ledger

Seams that repeated fixes keep pressing on, with the smallest intervention that
would remove several of their special cases and the threshold for acting on it.
An architecture pass updates this file. When an entry crosses its trigger, the
pass files at most three `tech-debt` issues (never `ai-ready`; a human chooses
which debt to work). "Defer" is a valid verdict. Drop entries once they expire.

Covered through: 6bd522a0970e1be18609b97cc763872346722b33

Passes: [#1205](https://github.com/xnmp/tauri-explorer/issues/1205)
(first pass, 2026-10-16), [#1219](https://github.com/xnmp/tauri-explorer/issues/1219)
(incremental pass, 2026-10-17), [#1251](https://github.com/xnmp/tauri-explorer/issues/1251)
(incremental pass, 2026-10-18), [#1262](https://github.com/xnmp/tauri-explorer/issues/1262)
(incremental pass, 2026-10-18), [#1277](https://github.com/xnmp/tauri-explorer/issues/1277)
(incremental pass, 2026-10-18).

## How the first pass inspected history

There was no earlier ledger, so #1205 covered the whole `dev` history
(2026-01-11 to `c53c2edcd7f4b87e62f09b19b8b303dccb0ed067`, 2,655 commits).
It counted per-file churn of
`fix:` commits for the whole history, then for before 2026-06-17, 2026-06-17 → 2026-08-17
and 2026-08-17 → the tip, to see which way each seam is trending. It then read the
commits, PRs and code behind the top seams. The v1.10–v1.11.2 range had already
been swept by the tech-debt tracker #895 (31 children, all closed by
2026-10-01), so this pass did not re-file anything that tracker resolved. Its
detailed reading starts from that sweep.

The first pass's aggregate churn command (source files only) was:

```sh
git log --since=<date> --until=<date> --no-merges --format='@@%H %s' --name-only \
  | awk '/^@@/{split($0,a," ");fix=(a[2] ~ /^fix/);next}
         NF&&fix&&/^(src|src-tauri)\//{c[$0]++} END{for(f in c)print c[f],f}' \
  | sort -rn
```

The [first-pass review](https://github.com/xnmp/tauri-explorer/pull/1207#pullrequestreview-5541851979)
found that PreviewPane's middle-period count of 14 needs `--follow`; the
aggregate command returns 12. For rename-aware counts, run that command's
`git log` with `--follow -- <one file>` separately. The distinction did not
change its intervention verdict.

## Incremental inspection (#1219)

Inspected every commit in
`c53c2edcd7f4b87e62f09b19b8b303dccb0ed067..ebd351f3f4149e294fbff621137c124e33e7146b`
(six commits), including changed production boundaries, tests, workflow wiring,
lessons and the PR bodies, comments, reviews and review threads. The upper bound
is the fetched `dev` tip inspected for this pass, not this documentation commit.

| Change | Evidence and disposition |
| --- | --- |
| [First ledger (#1207)](https://github.com/xnmp/tauri-explorer/pull/1207) | Documentation only. Carry forward its four deferred seams and account for the review's rename-count correction above. |
| [Test-result cache (#1204)](https://github.com/xnmp/tauri-explorer/pull/1204) | Read workflow, Turborepo inputs, cache transport/records, runner and affected-selection changes. The [review sequence](https://github.com/xnmp/tauri-explorer/pull/1204#pullrequestreview-5542120849) found expiration-before-setup, PR write provenance, rerun discovery, passing targets in failed attempts and older matching archives; the [final review](https://github.com/xnmp/tauri-explorer/pull/1204#pullrequestreview-5542999109) accepts their fixes. `tests/test-cache.test.ts` exercises real archives/replay. Residual: protected-dev-only publication trades hit rate for trust; hosted hit-rate improvement was still unverified in the PR. One new subsystem with resolved review findings does not yet justify another abstraction. Revisit if subsequent fixes duplicate target/hash/probe policy. |
| [Windows Trash names (#1210)](https://github.com/xnmp/tauri-explorer/pull/1210) | Exact Shell filenames now feed display, collisions and restore; native tests cover `.txt`, `.txt.txt`, extensionless files and folders. The [final review](https://github.com/xnmp/tauri-explorer/pull/1210#pullrequestreview-5543268990) accepts the producing-layer regression and workflow scope reduction. Keep ADR 0019's opaque artifact identity; this is an adapter correction, not a checkpoint-engine bypass. |
| [Release metadata (#1213)](https://github.com/xnmp/tauri-explorer/pull/1213) | Changelog and synchronized package/application versions only; no new ownership boundary or pressured seam. No review threads were present. |
| [Preview dispatch (#1211)](https://github.com/xnmp/tauri-explorer/pull/1211) | Retires the filed intervention below. The PR's CI-repair section records the state-to-component import violation and its fix: lazy viewer factories stay in the UI layer. Preserve that dependency direction (ADR 0008). |
| [Trash, shortcuts and Linux drag/drop (#1218)](https://github.com/xnmp/tauri-explorer/pull/1218) | Read opaque-ID purge/admission, virtual-root history, command binding and terminal ownership changes, plus native drag adoption, Wry receiver snapshots and native outcome coverage. Purge reuses prepared permanent deletion; it does not add a durable recovery engine. Shortcut dispatch removes the hardcoded terminal branch. The drag audit's remaining platform limits become the watch entry below. No PR review threads were present; its independent-review results are claims in the PR/audit, not GitHub review records. |

### Retired intervention

[Preview content dispatch #1206](https://github.com/xnmp/tauri-explorer/issues/1206)
is closed by [#1211](https://github.com/xnmp/tauri-explorer/pull/1211), within this
inspection range. `domain/preview-kind.ts` now supplies dispatch and image-hold
classification; `state/preview-content.ts` owns one `PreviewContent` union,
loading, stale-result guards, cache and blob ownership. The component supplies
lazy viewer factories and renders whole-content replacements. The
[approval](https://github.com/xnmp/tauri-explorer/pull/1211#pullrequestreview-5545403989)
and PR's CI-repair verification cover that boundary. Its expiry condition has
therefore been met; remove it from the active entries rather than re-file it.

### Filing decision

Checked all open/closed `tech-debt` filings and related drag issue titles:
#1206 is the only labelled filing and is already resolved. No remaining entry
crosses its threshold at this boundary, so this pass files **zero** issues.
Existing [#1137](https://github.com/xnmp/tauri-explorer/issues/1137) remains open
and owns renderer-workaround retirement; do not duplicate it.

## Incremental inspection (#1251)

Inspected all six commits in
`ebd351f3f4149e294fbff621137c124e33e7146b..f3dfe80bc478ec8ea2b884a1c5706dda9e03eb7c`,
the fetched `dev` tip for this pass. Read their changed production boundaries,
tests, workflow wiring, design/acceptance documents and lessons, plus all six
PR bodies, comments, reviews and review threads. Only #1220 has a GitHub review;
all six have no comments or review threads. Independent-review claims in other
PR bodies are not additional GitHub review records. This boundary excludes the
ledger update itself and any later base changes.

| Change | Evidence and disposition |
| --- | --- |
| [Previous ledger (#1220)](https://github.com/xnmp/tauri-explorer/pull/1220) | Documentation only. Its [approval](https://github.com/xnmp/tauri-explorer/pull/1220#pullrequestreview-5555385780) confirmed local counts and boundaries but could not independently access GitHub discussions/statuses. This pass retrieved those for the current window and checked the carried-forward filing owners. |
| [Native DnD acceptance and context release (#1227)](https://github.com/xnmp/tauri-explorer/pull/1227) | `linux_html5::end_context` now releases the completed strong GTK context outside the tracker borrow, preserving immutable correlation history. Seven named filesystem/UI outcomes, current-binary provenance, fresh receipts and GTK acknowledgement suppression are enforced inside required Linux smoke. The [acceptance audit](testing/dnd-acceptance.md) and open [#1225](https://github.com/xnmp/tauri-explorer/issues/1225) retain platform, receiver and release-artifact gaps. This is one follow-up lifecycle correction after #1218, not two new identity/completion exceptions. |
| [Enclosed-tau icon (#1232)](https://github.com/xnmp/tauri-explorer/pull/1232) | Canonical raster, generated platform assets and favicons only; README preserves the existing generator boundary. No source-policy change or pressured seam. |
| [Open With readiness (#1235)](https://github.com/xnmp/tauri-explorer/pull/1235) | Test-only readiness correction: wait for the actual application button after deliberately delayed catalogue discovery, then retain exact focus and launch outcomes. No new production focus owner. Its release-run residual is the existing Git palette live-update defect [#1236](https://github.com/xnmp/tauri-explorer/issues/1236), not evidence of a peek or DnD ownership regression. |
| [Release metadata (#1230)](https://github.com/xnmp/tauri-explorer/pull/1230) | Changelog and synchronized versions only. Its publication plan and reported test results do not qualify every hook-free release artifact; broader qualification stays with #1225. |
| [Details Folder Peek (#1243)](https://github.com/xnmp/tauri-explorer/pull/1243) | Per-pane membership/listing resources extend `pane-watch` through lazy `pane-peek-watch`; first reads go directly through `pane-refresh`, notifications through `refresh-manager`. The 16-lease cap includes pending acquisition and failed retirement. Real-watcher tests cover child create/delete, nested Git index changes, pruning, overflow fan-out and collapse/reopen identity. Pure operation-root reduction and deepest-first rename handle cross-level selections. Lazy renderers retain FileList focus ownership. These extend ADR 0014, ADR 0015 and ADR 0016 rather than introduce a fourth refresh gate. Residuals: per-directory Git-status work is not yet deduplicated by repository root; Windows/UNC evidence is domain-only. List/Tiles peeks and spring loading are later phases, not regressions in this Details-only phase. |

### Filing decision

Rechecked all open/closed `tech-debt` filings and related drag/peek titles.
#1206 remains the sole labelled filing, closed by #1211. No active entry has
expired or crossed its intervention threshold, so this pass files **zero**
issues and retains five entries. Merge the new peek pressure into file-list
ownership below rather than add an overlapping watcher entry. Keep existing
[#1225](https://github.com/xnmp/tauri-explorer/issues/1225) for DnD qualification,
[#1137](https://github.com/xnmp/tauri-explorer/issues/1137) for renderer retirement,
and [#1228](https://github.com/xnmp/tauri-explorer/issues/1228) for the native Trash
test's stale locator; none warrants a duplicate architecture filing. No labels
were changed. Existing expiries remain in force rather than restarting the clock.

## Incremental inspection (#1262)

Inspected all six commits in
`f3dfe80bc478ec8ea2b884a1c5706dda9e03eb7c..b9ef798baeb45037847337deaaa8390cebdc568d`,
the prepared branch's `origin/dev` base tip. This starts at the recorded
coverage boundary, so it includes the previous ledger commit. Read the changed
production boundaries, tests, execution plan, lessons and code-map updates,
plus all six PR bodies, comments, reviews and review threads. Only #1252 and
#1256 have GitHub reviews; all six have no comments or review threads, with no
unread conversation pages. Review claims inside the other PR bodies are not
GitHub review records. PR bodies can be edited after merge: #1249's current
body includes #1257 integration results, which are attributed separately below.

| Change | Evidence and disposition |
| --- | --- |
| [Previous ledger (#1252)](https://github.com/xnmp/tauri-explorer/pull/1252) | Documentation only. Its [approval](https://github.com/xnmp/tauri-explorer/pull/1252#pullrequestreview-5558141476) verified local boundaries and fields but could not access GitHub discussions or filing statuses. This pass fetched both for this window and rechecked the existing owners. |
| [Optional Folder Peek carets (#1250)](https://github.com/xnmp/tauri-explorer/pull/1250) | `shouldToggleOnRowClick` keeps modifier/drag eligibility in the domain and routes plain clicks through the existing `togglePeek`. Caret visibility and guide geometry change without another listing, refresh or focus owner. Unit and browser contracts cover selection, expansion, double-click navigation, alignment and live settings. This is feature growth inside the file-list seam, not a deployed recurrence. |
| [Selectable icon packs (#1249)](https://github.com/xnmp/tauri-explorer/pull/1249) | File identity/category and folder decoration are domain policy; transient picker preview lives in `icon-theme` state, committed choice in settings, and same-ID CSS reloads publish a theme revision. Shared folder decoration also covers photo folders. Deterministic external sprites keep artwork out of startup JavaScript, with freshness/identity/license contracts and browser pixel coverage. No new native commands or observation owners. These extractions already remove alias/category and folder-renderer special cases; one feature and the test correction below do not establish recurring icon architecture debt. |
| [Native Git-watch readiness (#1256)](https://github.com/xnmp/tauri-explorer/pull/1256) | Normalize runner paths with the publisher's `directoryKey` before WebDriver serialization. The [approval](https://github.com/xnmp/tauri-explorer/pull/1256#pullrequestreview-5558526088) independently checked Windows/UNC/WSL positive and negative acknowledgement cases, while noting native execution was unavailable. This fixes a test precondition, retaining the real staged-file badge, watcher cap, pruning and retirement outcomes. Native observation policy is unchanged; do not count it as another recovery/watch ownership defect. |
| [Minimal icon assertion (#1257)](https://github.com/xnmp/tauri-explorer/pull/1257) | Scope color reads to owned file glyphs and retry the nonempty shared foreground plus distinct folder color when a video placeholder is replaced. Both glyph sizes remain covered. This is a test locator/lifetime correction, not a second icon-paint policy or a production icon regression. |
| [List column flow (#1258)](https://github.com/xnmp/tauri-explorer/pull/1258) | One pure placement snapshot feeds horizontal virtualization, reveal and keyboard movement. `use-list-columns` owns scroll/resize work; FileList retains focus, and outgoing renderers clear only their own bindings. A shared UI-layer loader publishes settled renderers and starts chunks alongside listing. This extends the ownership principles in ADR 0011 and ADR 0015. Classic row-major List remains selectable with Folder Peek off; List peeking is still a later phase. Residuals: the PR reports higher whole-column wheel work under 4× CPU throttling, no native wheel/WebKitGTK compositing qualification, and 52 full-run browser failures attributed to host resource exhaustion; those claims are not an independently rerun all-view pass here. The hover-feedback change is assessed in the drag entry below. |

### Filing decision

Rechecked every open/closed `tech-debt` filing: #1206 is still the only one,
closed by #1211. No active entry has expired or crossed its intervention
threshold. The six monitored file-list/page files still have 1 / 3 / 1 / 1 / 1 / 5
`fix:` commits since 2026-09-18 at this tip (same command and file order as
below), and the mock dispatcher is unchanged at 3,225 lines. No backend or
workflow file changed in this window. File **zero** issues, retain five entries,
and merge the List/caret/loader pressure into existing file-list ownership.
Keep the existing expiries rather than resetting them for feature growth.

[#1137](https://github.com/xnmp/tauri-explorer/issues/1137),
[#1225](https://github.com/xnmp/tauri-explorer/issues/1225) and
[#1228](https://github.com/xnmp/tauri-explorer/issues/1228) remain open for renderer
workaround retirement, wider native DnD qualification and native Trash locators,
respectively. Reuse these owners; no duplicate debt filing or label change is
warranted. Treat List's reported wheel cost/native-input gap as a residual to
recheck on real hardware or in the next view phase, not an established repeated
ownership defect.

## Incremental inspection (#1277)

Inspected all seven commits in
`b9ef798baeb45037847337deaaa8390cebdc568d..6bd522a0970e1be18609b97cc763872346722b33`,
the fetched `origin/dev` tip, including the previous ledger update. Read changed
production ownership boundaries, tests, workflow/cache wiring, the execution
plan and lessons, plus all seven PR bodies, comments, reviews and review threads.
Only #1261 and #1263 have GitHub reviews; none has comments or review threads,
and every conversation connection reports no further page. Review narratives
in feature PR bodies are implementation reports, not GitHub review records.

| Change | Evidence and disposition |
| --- | --- |
| [Native peek overflow expectation (#1261)](https://github.com/xnmp/tauri-explorer/pull/1261) | The [approval](https://github.com/xnmp/tauri-explorer/pull/1261#pullrequestreview-5558978885) accepts a causal root-notification receipt and displayed fresh child instead of assuming an evicted peek stays stale. The test explicitly touches directory metadata to exercise Windows' ancestor-notification path on Linux. It preserves cap, Git, pruning and retirement checks; production observation is unchanged (ADR 0013 and ADR 0014). |
| [Previous ledger (#1263)](https://github.com/xnmp/tauri-explorer/pull/1263) | Documentation only. Its [approval](https://github.com/xnmp/tauri-explorer/pull/1263#pullrequestreview-5559050800) verified boundaries, fields, counts and expiries but could not access GitHub discussions/statuses. This pass retrieved conversations and rechecked filing owners. |
| [List cards (#1265)](https://github.com/xnmp/tauri-explorer/pull/1265) | Pure structure/sizing/placement and navigation share one model; the composable owns scroll, grip and mounted windows, FileList still owns focus. Motion uses shared pure arming/reveal policy and inert identity-free ghosts. Session heights stay with peek state; surface feedback has an importable owner. Intra-PR focus, grip, reveal, accessibility and perf corrections are not separate deployed recurrences. Residual: reported concurrent production A/B scroll-back cost is +21–26%, +11% with carets off; improved wheel results do not establish native input/compositing performance. |
| [Tiles panels and thumbnail ownership (#1266)](https://github.com/xnmp/tauri-explorer/pull/1266) | Pure panel geometry/navigation feeds variable-height VirtualList groups; the view composable owns motion, reveal and grip lifetime. Panel-side memory is pane session state. `thumbnail-loads` moves in-flight loads out of unmounted components into one cache-key owner, retaining results and allowing remounts to join (ADR 0008). This is an intervention already made, not grounds to file another extraction. Residuals: reported task cost +9–18% with no panel, +9–16% with one, and a brief above-panel first-frame sliver. Pre-existing crop invalidation is owned by open [#1267](https://github.com/xnmp/tauri-explorer/issues/1267). Turbo output now streams so shard timings are measurable; no cache-trust/publication policy changed. |
| [Spring-loaded peeks (#1268)](https://github.com/xnmp/tauri-explorer/pull/1268) | One pure timer controller and lazy driver serve DOM, native and pointer drag adapters. Temporary peeks project through existing listings/watch caps without entering user expansion or size memory. Shared row identity drives hover and drop; deferred closes/holds preserve destination resolution. Pointer drags survive virtualization but cancel when the source leaves its listing. Native source snapshots and Rust/Wry completion ownership are unchanged. Open [#1269](https://github.com/xnmp/tauri-explorer/issues/1269) owns lost-Leave cleanup, old replay closing a newer spring, probe tightening and lingering background feedback. Native tests record a peek-open token and assert close plus final transfer into the hovered folder; #1269 still asks for stricter probe timing. A dedicated native drop *inside* the peek is deferred. The Chromium job cap rises to 30 minutes after an all-passing shard exceeded 20 minutes; this does not remove test assertions. |
| [Late command registration (#1271)](https://github.com/xnmp/tauri-explorer/pull/1271) | An open palette now observes owned-registry list changes through `reactive-registry`; point lookups remain untracked and stale disposers cannot remove replacements. Client-compiled unit tests cover mutation notifications and registration-effect loops; the browser contract enables/disables a plugin while the palette stays open. Peek startup exposed an older missing reactive dependency, not a listing/watch regression. The smallest ownership wrapper has already landed; retain ADR 0008 rather than introduce another registry owner. |
| [Peek coverage audit (#1273)](https://github.com/xnmp/tauri-explorer/pull/1273) | Tests only: cross-level List range, root-only Ctrl+A/typeahead, rendered Tiles grip increments/bounds and recursive Details sort. The PR records mutation controls for each, with no product defect found. Its body says all five gaps close, but the actual commit/title closes gaps 1–4: [#1272](https://github.com/xnmp/tauri-explorer/issues/1272) is still open, has no comments and still owns the missing perf medians. Do not treat approximations in earlier PRs or a promised later comment as that evidence. |

### Filing decision

Rechecked all open/closed `tech-debt` filings: #1206 remains the only labelled
filing and is closed. No entry has expired or crossed its trigger. File **zero**
issues and retain five entries, merging List/Tiles/spring pressure into file-list
ownership and drag lifetime below. Preserve all existing expiry dates.

At this tip the six monitored page/file-list files still have
1 / 3 / 1 / 1 / 1 / 5 `fix:` commits since 2026-09-18 (same command and file
order as below); neither new `fix:` commit touches them. The mock dispatcher
is 3,226 lines, one more fixture branch, below 4,000; no native commands,
backend files or governing ADRs changed. Renderer retirement [#1137](https://github.com/xnmp/tauri-explorer/issues/1137),
DnD qualification [#1225](https://github.com/xnmp/tauri-explorer/issues/1225),
native Trash locators [#1228](https://github.com/xnmp/tauri-explorer/issues/1228),
thumbnail invalidation #1267, spring follow-ups #1269 and perf evidence #1272
are all open. Reuse their existing scope; no duplicate filing or label change
is warranted. Native drop-inside-peek and platform delivery gaps stay explicit;
synthetic/browser success does not discharge them.

## Entries

Undated historical churn counts below are the first pass's snapshots at its
boundary; this pass's measurements and incremental evidence are identified
separately.

### Native command surface (registration, mock and IPC wrapper) — defer

- **Seam:** each Tauri command is registered in `src-tauri/src/lib.rs`, wrapped
  in `src/lib/api/*`, and faked in `src/lib/api/mock-invoke.ts` (3,225 lines
  at the #1251 boundary)
  for browser E2E.
- **Evidence:** `lib.rs` (10) and `mock-invoke.ts` (9) are the next most-fixed
  files since 2026-08-17. Across the three periods above they had 25 / 17 / 10
  and 14 / 23 / 9 `fix:` commits. Almost every feature since 2026-10-01 touched both of
  them (#1048, #1088, #1090, #1109, #1140, #1183, #1185, #1190). Earlier
  mock-drift fixes: #117, the 2026-05-13 unmocked-commands fix, #472, #868,
  #869. Since the parity contract `tests/api/mock-invoke-parity.test.ts`
  (#869 via [#917](https://github.com/xnmp/tauri-explorer/pull/917)) landed,
  no drift fix has been needed. In this window,
  [#1218](https://github.com/xnmp/tauri-explorer/pull/1218) wires
  `delete_trash_items` and `end_html5_file_drag` through these same surfaces;
  these are feature additions, with no reported parity escape.
  Since that window, [#1243](https://github.com/xnmp/tauri-explorer/pull/1243)
  adds controllable child listings and subtree rename fixtures, but no native
  commands or parity escape. The dispatcher grew by 13 lines.
  The #1262 range changes neither command registration, wrappers nor mocks;
  `mock-invoke.ts` remains at 3,225 lines. Icon packs and List flow add no IPC
  dispatch surfaces.
  The #1277 range adds only a delayed-thumbnail fixture branch (#1266), taking
  the mock to 3,226 lines. It adds no native command or reported parity escape.
- **Trend:** the touch rate is rising with feature work; the drift-fix rate has
  fallen to zero since #917. The changes to `lib.rs` are wiring, not defects.
  The file remains below the 4,000-line trigger.
- **Candidate intervention:** split `mock-invoke.ts` by domain, following the
  module split of `src/lib/api/*`. A dispatch table would let each domain own
  its fakes, and the parity test would still list every command.
- **Reconsideration trigger:** a mock/real drift defect that the parity test
  misses, or `mock-invoke.ts` passing 4,000 lines.
- **Expiry:** 2027-01-16.

### Linux WebKitGTK renderer configuration and child-process environment — defer

- **Seam:** `src-tauri/src/webkit_renderer.rs` sets renderer workarounds in the
  app's own environment. Every process the app spawns has to opt in to
  removing them (`child_env::scrub_command` / `scrub_pty`), alongside the
  separate per-spawn Windows opt-in `process_ext::NoConsole`.
- **Evidence:** renderer fixes #1057/#1060, #1071/#1077, #1026/#1136 (DFG
  workaround, with #1137 open to retire it) and #1145. The environment leak
  [#1079/#1141](https://github.com/xnmp/tauri-explorer/pull/1141) had two CI
  follow-ups (#1178, #1180). The scrub is opt-in at
  four call sites (`terminal.rs`, `system.rs`, `files/external_apps.rs`, and
  the `system.rs` launcher loop), while about 30 other modules spawn
  processes directly. No renderer/child-environment policy changed in this
  window. The GTK source fix in #1218 concerns drag transport, not a missed
  environment scrub; [#1137](https://github.com/xnmp/tauri-explorer/issues/1137)
  remains open, so the early expiry has not fired.
  The #1251 range likewise leaves renderer policy and child-environment
  scrub sites unchanged; #1227's GTK interposer is test-only transport evidence.
  The #1262 range changes no backend files. #1137 is still open, so neither
  the early expiry nor an additional per-spawn policy/leak trigger has fired.
  The #1277 range also changes no backend or child-environment policy; #1137
  remains open at inspection, so neither trigger nor early expiry has fired.
- **Trend:** new (all since 2026-10-11) and driven by the upstream WebKitGTK
  2.52 releases.
- **Candidate intervention:** a single `process_ext` constructor for user-facing
  launches that applies both the console flag and the environment scrub, so a
  new launch site cannot forget either. Internal tool spawns such as `git`
  would keep plain `Command`.
- **Reconsideration trigger:** a second environment leak or console-flash
  report from a launch site that missed an opt-in, or a third per-spawn policy.
- **Expiry:** 2027-01-16, or earlier once #1137 retires the DFG workaround.

### Durable file recovery (`src-tauri/src/files/recovery/`) — defer

- **Seam:** the durable move/copy recovery engine (48 Rust files, about
  14.3k lines). ADRs 0018–0020, 0023 and 0026 are still *Proposed*.
- **Evidence:** consolidation landed in #874/#946 (one checkpoint engine), #875
  (one tree removal), #878/#940 (one admitted-execute seam) and #880/#943 (the
  feature is opt-in and Linux-only). Since then there have been two fixes:
  #1154 (parent-alias claims) and #1163 (edited move record), plus the
  coverage work [#1162](https://github.com/xnmp/tauri-explorer/pull/1162).
  This window changes no file under `files/recovery/`.
  [#1210](https://github.com/xnmp/tauri-explorer/pull/1210) preserves exact
  restore identities and #1218's purge uses the existing admission and prepared
  permanent-delete seams; neither bypasses the checkpoint engine. The five
  named ADRs are still Proposed in the ADR index.
  The #1251 range also leaves `files/recovery/` untouched. #1243 reduces
  recursive selections before existing batch APIs; it adds no recovery engine
  or admission bypass.
  The #1262 range again changes no recovery code or governing ADR status;
  no new checkpoint/admission bypass contributes to the 30-day trigger.
  The #1277 range likewise leaves recovery and governing ADRs unchanged.
  Peek renderers and drag adapters continue through existing mutation APIs.
- **Trend:** falling since the 2026-10-01 consolidation.
- **Candidate intervention:** none yet. First accept or revise the Proposed
  ADRs, so that later fixes have a written contract to check against.
- **Reconsideration trigger:** three recovery `fix:` commits within 30 days
  that bypass the checkpoint engine or the admission seam.
- **Expiry:** 2027-01-16.

### File-list views and page shell — defer (watch for regression)

- **Seam:** `src/routes/+page.svelte`, `FileList.svelte`, `FileItem.svelte`,
  `MillerColumns.svelte`, `TilesView.svelte` and `explorer.svelte.ts`, which
  are the top fix-churn files over the whole history (60, 56, 26, 24, 22 and
  38 `fix:` commits).
- **Evidence:** `fix:` commits before 2026-06-17, from 2026-06-17 to
  2026-08-17, and since 2026-08-17: `FileList.svelte` 46 / 5 / 5,
  `+page.svelte` 35 / 21 / 4, `explorer.svelte.ts` 26 / 8 / 4,
  `FileItem.svelte` 23 / 2 / 1, `MillerColumns.svelte` 20 / 4 / 0. The drop
  follows the ownership ADRs 0010 (page session), 0011 (viewport geometry), 0014 (observed navigation) and
  0015 (keyboard cursor), and the retained-tab work in #1173 (landed as
  [#1193](https://github.com/xnmp/tauri-explorer/pull/1193)).
  [#1218](https://github.com/xnmp/tauri-explorer/pull/1218) adds exact source-row
  disposal and virtual Trash history/confirmation, without a new refresh or
  focus owner. At the inspected tip, `fix:` counts since 2026-09-17 are page 1,
  FileList 3, FileItem 1, MillerColumns 1, TilesView 1 and explorer 5
  (`git log <covered-tip> --since=2026-09-17 --no-merges --format='%s' -- <file>`,
  count subjects beginning `fix:`).
  At the #1251 boundary, the same counts since 2026-09-18 are still
  1 / 3 / 1 / 1 / 1 / 5, respectively. The large
  [#1243](https://github.com/xnmp/tauri-explorer/pull/1243) feature adds child
  publication, watch-cap/fallback and lazy-focus seams; its intra-PR corrections
  are not separate deployed follow-up defects. `folder-peek-session` owns
  listing identities, `pane-peek-watch` extends observation ownership, and
  `pane-refresh` partitions selection reconciliation by actual parent. The
  native `folder-peek-watch.spec.ts` and unit cap/late-acquisition contracts
  exercise those boundaries. Keep this pressure in this entry, not a second
  refresh/watch ledger item. The PR explicitly leaves per-repository Git-status
  deduplication and native Windows/UNC qualification unresolved.
  In the #1262 range, #1250 adds caret-less click policy through `togglePeek`,
  and [#1258](https://github.com/xnmp/tauri-explorer/pull/1258) adds a distinct
  horizontal List renderer, pure shared placement/navigation, and one lazy
  renderer loader. Identity-checked callback retirement and FileList-owned
  deferred focus preserve ADR 0015's ownership direction. Its geometry and
  renderer corrections are inside that feature, not subsequent deployed fixes.
  Counts since 2026-09-18 remain 1 / 3 / 1 / 1 / 1 / 5 at this boundary.
  [#1256](https://github.com/xnmp/tauri-explorer/pull/1256) corrects readiness
  normalization in the native watcher test, not production observation.
  In the #1277 range, #1265/#1266 add List cards and Tiles panels, with pure
  models shared by rendering/reveal/navigation and session-owned size/side
  memory; #1268 projects temporary peeks through existing resources. These
  extend ADR 0011, ADR 0014 and ADR 0015 rather than create another refresh
  gate or focus queue. #1261 corrects ancestor-notification expectations, and
  #1273 adds missing observable selection/sort/grip tests without product fixes.
  Counts since 2026-09-18 remain 1 / 3 / 1 / 1 / 1 / 5. Keep the reported
  List/Tiles overhead, pending medians (#1272), and native-input gap explicit.
  #1266 already extracts thumbnail request lifetime into a cache-key owner;
  #1267 owns the distinct crop-key invalidation defect. #1271's reactive
  command wrapper repairs a palette dependency, not peek navigation ownership.
- **Trend:** below the existing trigger in every file; retain the falling
  first-pass assessment, but the short incremental windows cannot establish
  a new long-term trend. Peek adds ownership complexity without a deployed
  recurrence yet; List adds renderer/geometry/focus complexity. Its reported
  throttled wheel cost and missing native-input qualification remain explicit
  limits, not evidence that another refresh or focus owner is needed.
  Three further feature phases increase renderer/gesture complexity, but the
  deployed fix count is unchanged. Shared motion arming and importable grip,
  thumbnail and spring owners already remove the reported local-lifetime cases.
- **Candidate intervention:** retain the existing ADR owners. If follow-up
  fixes repeat child/root publication or lease-cap exceptions, extend the
  existing `RefreshTarget` and pane-owned listing/observation seam rather than
  add a component-local watcher or general tree framework. #1243 already uses
  these seams to share initial/notification reads and mutation publication.
  For repeated renderer-swap/reveal failures, extend the existing shared
  loader and identity-bound view callbacks rather than add per-view focus
  queues; retain one placement snapshot for List rendering and navigation.
- **Reconsideration trigger:** more than 6 `fix:` commits to any one of these
  files within 30 days.
- **Expiry:** 2027-01-16.

### Native drag source ownership and receiver provenance — defer after #1218

- **Seam:** renderer HTML5 intervals (`state/html5-file-drag.svelte.ts`),
  `native_file_drag.rs` / `native_file_drag/linux_html5.rs`, and vendored Wry's
  GTK receiver must agree on one gesture's ownership, identity and completion.
  Copy transport acknowledgement is separate from application Move/Modifier
  policy. This is distinct from the renderer-environment seam above.
- **Evidence:** [#1098](https://github.com/xnmp/tauri-explorer/pull/1098)
  introduced native provenance and completion routing;
  [#1187](https://github.com/xnmp/tauri-explorer/pull/1187) added Wayland
  post-grab intent, with its
  [review](https://github.com/xnmp/tauri-explorer/pull/1187#pullrequestreview-5537145086)
  explicitly limiting evidence to protocol/downstream results.
  #1098's filed drag residual
  [#1095](https://github.com/xnmp/tauri-explorer/issues/1095) is already closed;
  do not re-file its recovered-session delivery defect.
  [#1218](https://github.com/xnmp/tauri-explorer/pull/1218) then fixes competing
  GTK source contexts, receiver action negotiation, multi-URI export,
  source-row disposal and delayed URI identity. The
  [coverage audit](testing/1217-dnd-coverage-audit.md#new-regression-review)
  reports 22,683 synthetic tests green on broken source, then the same three
  real native outcome tests red before and green after the fix. Historical
  controls refute attributing onset to #1098; they use today's GTK runtime,
  not historical platform builds.
  [#1227](https://github.com/xnmp/tauri-explorer/pull/1227) finds a concrete
  lifetime defect: completed strong GTK contexts kept the cancellation window
  alive. It releases the context outside the shared borrow without adding
  identity inference; the real Escape/retry contract rejects the old behavior.
  The [new acceptance audit](testing/dnd-acceptance.md) records the earlier
  zero-DnD green rollback, seven required run-bound outcomes and transport
  negative control. #1243 accepts row `dragenter` as well as `dragover` and
  reduces recursive sources through domain policy; neither creates another
  native identity/completion owner.
  [#1258](https://github.com/xnmp/tauri-explorer/pull/1258) adds re-hit-testing
  after sideways scroll and a `shouldRetireOnDragEnd` domain decision for
  cancelled/sessionless hover feedback. This adds renderer feedback lifetime
  cases, but deliberately retains captured native Drop provenance; it changes
  no Rust/Wry source context, identity inference or transfer-completion owner.
  Unit tests exercise stale dragend and sessionless cancellation, and browser
  tests exercise a drop after scroll; these do not qualify native delivery.
  In the #1277 range, #1268 adds spring holds, deferred closing and shared
  hit identity in frontend adapters. It preserves pinned native provenance;
  surviving a virtualized pointer-source row does not infer a new source.
  Open #1269 records spring cleanup/session isolation defects, including an
  old replay closing a newer drag's peeks; it does not report stale internal
  Move authority. Reuse that owner instead of counting each intra-feature
  correction as a deployed native identity/completion fix. Native tests add a
  peek-open token and close assertions to existing transfers, but #1269 retains
  probe-timing limits. A dedicated native drop-inside-peek test remains deferred
  because the helper lacks a second waypoint.
- **Trend:** repeated native ownership/intent changes in October; #1218 adds
  a dedicated adapter and real GTK X11 transfer coverage, so observe that
  intervention before proposing another extraction. Physical GNOME Wayland,
  cross-window and external-application delivery remain unqualified by those
  three GUI cases; Rust/protocol contracts cover narrower interleavings.
  #1227 expands the required GTK X11 gate to seven outcomes. It is one new
  lifecycle correction, not the two further identity/exception fixes in the
  trigger. Wider acceptance remains open in
  [#1225](https://github.com/xnmp/tauri-explorer/issues/1225); do not convert a
  qualification gap into an unobserved stale-Move defect.
  #1258's feedback retirement is not a second native identity/completion
  exception after #1227: native Drop still consumes its prior captured source.
  No new stale internal Move authority is demonstrated in this range, and
  #1225 remains open for the broader platform/receiver evidence.
  #1268 increases frontend gesture-lifetime pressure, with concrete residuals
  owned by #1269. No second native identity/completion exception or stale Move
  authority is demonstrated; required GTK transfer coverage is retained.
- **Candidate intervention:** extend the existing exact-session lifecycle and
  pinned `SourceSnapshot` boundary if another transport needs it. The smallest
  further abstraction would be a typed source lease (adopt/bind/complete) shared
  by source and receiver adapters, replacing additional path/time inference or
  per-owner completion exceptions. Keep domain copy policy separate, and retain
  the real filesystem outcome tests; another synthetic policy matrix cannot
  replace them.
- **Reconsideration trigger:** two further ownership fixes after #1218 within
  30 days that add alternative identity inference or completion exceptions
  across these layers, or one demonstrated external gesture inheriting stale
  internal Move authority despite the pinned context. Neither is observed at
  this boundary. Unverified platform delivery alone is not proof of that bug.
- **Expiry:** 2027-01-17; drop this entry if the next 90 days bring no such
  recurrence, otherwise reassess against the native evidence before extending.
