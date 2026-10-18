# Architecture pressure ledger

Seams that repeated fixes keep pressing on, with the smallest intervention that
would remove several of their special cases and the threshold for acting on it.
An architecture pass updates this file. When an entry crosses its trigger, the
pass files at most three `tech-debt` issues (never `ai-ready`; a human chooses
which debt to work). "Defer" is a valid verdict. Drop entries once they expire.

Covered through: d668d00b3469cdc408c82654b86b4ac4edaf46b9

Passes: [#1205](https://github.com/xnmp/tauri-explorer/issues/1205)
(first pass, 2026-10-16), [#1219](https://github.com/xnmp/tauri-explorer/issues/1219)
(incremental pass, 2026-10-17), [#1251](https://github.com/xnmp/tauri-explorer/issues/1251)
(incremental pass, 2026-10-18), [#1262](https://github.com/xnmp/tauri-explorer/issues/1262)
(incremental pass, 2026-10-18), [#1277](https://github.com/xnmp/tauri-explorer/issues/1277)
(incremental pass, 2026-10-18), [#1288](https://github.com/xnmp/tauri-explorer/issues/1288)
(incremental pass, 2026-10-18), [#1301](https://github.com/xnmp/tauri-explorer/issues/1301)
(incremental pass, 2026-10-19).

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

## Incremental inspection (#1288)

Inspected all seven commits in
`6bd522a0970e1be18609b97cc763872346722b33..afe5cc888540100b7c3ae0ace5a7b21daab4e89f`,
the fetched `origin/dev` tip and prepared branch base. Read every changed
text file, including production boundaries, tests, lessons, code maps and the
execution plan; image additions are screenshot evidence, not new owners.
Retrieved all seven PR bodies, comments, reviews and review threads. Only
#1280 and #1279 have GitHub reviews; none has comments or review threads, and
all conversation connections report no further page. Adversarial-review reports
inside PR bodies are attributed reports, not additional GitHub review records.

| Change | Evidence and disposition |
| --- | --- |
| [Thumbnail invalidation (#1276)](https://github.com/xnmp/tauri-explorer/pull/1276) | Matches the real `kind:path:size:quality` cache keys for eviction and rename, revokes removed blobs and notifies mounted tiles to reload. Tests now use producing-layer keys, including Windows/colon paths; the browser contract observes a changed loaded source after crop replacement. Closes #1267. Residual: `thumbnail-loads` can still publish or rejoin an old in-flight request after invalidation; retain ADR 0008's writer-revocation direction rather than create a second loader. |
| [Previous ledger (#1280)](https://github.com/xnmp/tauri-explorer/pull/1280) | Documentation only. Its [approval](https://github.com/xnmp/tauri-explorer/pull/1280#pullrequestreview-5561771490) verified local boundaries/counts but lacked GitHub access. This pass retrieved the current window's conversations and rechecked carried-forward issue statuses. |
| [Deterministic Tiles motion probe (#1279)](https://github.com/xnmp/tauri-explorer/pull/1279) | Controls rAF and performance time, retaining intermediate rendered heights, identity-free inert ghosts and reduced-motion outcomes despite a deliberate runner delay. The [approval](https://github.com/xnmp/tauri-explorer/pull/1279#pullrequestreview-5561786655) accepts the producing-layer probe, but could not rerun browsers. Test-only correction; no new production motion owner or recurrence. |
| [Website peek demo (#1278)](https://github.com/xnmp/tauri-explorer/pull/1278) | `website/peek.js` owns demo expansion, card/panel placement and keyboard/motion behavior, called by `app.js`; it uses the site's fake filesystem, not app IPC or watchers. Reported browser checks and screenshots cover the showcase. Main-pane-only operation, no nested rename/closing animation and simplified Tiles placement are explicit demo limits. A first demo implementation does not establish repeated app ownership debt. |
| [Spring gesture and late-drop follow-ups (#1282)](https://github.com/xnmp/tauri-explorer/pull/1282) | Scopes controller ends/holds and DOM replay feedback to a gesture; adds a held-aware lost-Leave fallback and a bounded per-session destination capture checked against the spring revision. Unique path-set fallback chooses a destination, without restoring internal Move authority. Handler tests assert dispatched folder/claim/cancel outcomes; native probes now reject post-end opening and closure masked by the 500ms fallback. Closes #1269. Residual [#1283](https://github.com/xnmp/tauri-explorer/issues/1283) owns late drops after navigation, watcher reorder or view changes outside the spring revision. No Rust/Wry provenance owner changed. |
| [Peek spec completion (#1285)](https://github.com/xnmp/tauri-explorer/pull/1285) | Documentation status/checkboxes only. Trace its performance claim to the actual [#1272 measurement comment](https://github.com/xnmp/tauri-explorer/issues/1272#issuecomment-6246681704), not to #1273's earlier test commit. Native drop-inside-peek and platform acceptance remain separate from the checked browser outcomes. |
| [Merge-base/filter race (#1286)](https://github.com/xnmp/tauri-explorer/pull/1286) | Moves the path-filter timer into importable state. Accepted lookup start parks a pending reload; current settlement cancels it after reveal or releases it on failure. Later input still supersedes the jump. Fake-timer tests assert reveal/result and failed-jump reload outcomes; the PR reports repeated browser success. Query generation already prevented stale query publication. This is one corrected timer boundary under ADR 0008, with no extra refresh policy. |

### Filing decision

Rechecked all open/closed `tech-debt` issues: #1206 remains the only labelled
filing, already closed. **Zero** new issues filed in this pass; no labels changed.
All five entries remain below their existing triggers and unexpired on
2026-10-18. Consolidate current evidence into them and preserve their expiry
dates; neither the demo nor a single graph timer fix merits a new watch entry.

Counts since 2026-09-18 at this tip are 1 / 4 / 1 / 1 / 1 / 5 for the six
page/file-list files in the order below: #1282 adds one FileList fix. The mock
stays at 3,226 lines. No backend, vendored Wry, workflow or governing ADR changed.
#1282's target capture/feedback cleanup is not a second native source-identity
or completion exception after #1227; source authority is still pinned.

Renderer retirement #1137, wider DnD qualification #1225 and native Trash
locators #1228 remain open. #1267 and #1269 are closed by the fixes above;
reuse open #1283 for the remaining destination-layout defect. #1272 is now
closed with five-run Chromium medians on the earlier covered tip: List
open/close task time 590/293ms, Tiles 643/315ms (10,000-entry root, 5,000-entry
peek). Its comment reports host load 3–6 and about 10% extra Tiles scroll task
cost with peek enabled. These are reported local measurements, not a new
benchmark or native wheel/compositor qualification. The thumbnail in-flight
residual remains explicitly unresolved below, without evidence of repeated
fixes that would cross the current file-list trigger.

## Incremental inspection (#1301)

Inspected all seven commits in
`afe5cc888540100b7c3ae0ace5a7b21daab4e89f..d668d00b3469cdc408c82654b86b4ac4edaf46b9`,
the fetched `origin/dev` tip and prepared branch base. Read every changed text
file, including the preceding ledger consolidation, production boundaries,
tests, bundle gate, lessons and code maps. Screenshot additions document the
features; they do not add resource owners. Retrieved all seven PR bodies,
comments, reviews and review threads. Only #1289 and #1293 have GitHub reviews;
none has comments or review threads, and every conversation connection reports
no further page. Review and mutation reports inside other PR bodies remain
attributed implementation evidence, not additional GitHub reviews or locally
rerun native qualification.

| Change | Evidence and disposition |
| --- | --- |
| [Late-drop destination (#1287)](https://github.com/xnmp/tauri-explorer/pull/1287) | Closes #1283: every post-dragend Drop with a capture uses it, independent of spring revision. Missing/unverifiable filesystem folders cancel after claiming the drop, before transfer; provider targets skip the filesystem check. External Drops cannot borrow captures by path set, and a delivered native Leave retires its gesture's capture. Handler tests assert dispatched destination, cancellation and duplicate-claim outcomes. The reported intra-PR external misdrop selected an old destination; it did not grant internal source/Move authority. Rust/Wry provenance is unchanged. This completes the existing destination owner rather than adding another identity heuristic. No new real native filesystem-outcome test is added. |
| [Previous ledger (#1289)](https://github.com/xnmp/tauri-explorer/pull/1289) | Documentation only. Its [approval](https://github.com/xnmp/tauri-explorer/pull/1289#pullrequestreview-5562431024) confirmed local boundaries/counts but could not access GitHub discussions or statuses. This pass retrieved the current window's conversations and rechecked carried-forward follow-ups. |
| [Spring fallback cancellation coverage (#1291)](https://github.com/xnmp/tauri-explorer/pull/1291) | Closes #1290 with a fake-timer controller outcome: after endSoon/end, the same gesture's renewed hover survives the obsolete fallback deadline. The PR reports failure when end's cancellation is removed. The fallback's separate scope guard remains redundant and is documented as unobservable under the existing lifecycle. Test-only; no new timer owner or production recurrence. |
| [Spring hit-test readiness (#1293)](https://github.com/xnmp/tauri-explorer/pull/1293) | Waits for populated children and completed List motion before synthetic crossing probes sample row edges. A final bounding box previously included still-clipped pixels. The [approval](https://github.com/xnmp/tauri-explorer/pull/1293#pullrequestreview-5562728857) confirms unchanged crossing/departure/short-hover assertions, but could not rerun browsers. The PR reports 40 WebKit cases and repeated crossing runs. This fixes test readiness, not production spring or observation ownership. |
| [Tiles tab chrome and shared sizing (#1296)](https://github.com/xnmp/tauri-explorer/pull/1296) | Removes the mini-tile layout and renders panel children with the grid's TileLayout. A per-panel track carries narrow-segment clamping through model, navigation, renderer and closing ghosts. Selected/focused open parents leave the panel-facing edge open; drag tint retains priority. Unit geometry/navigation contracts and browser box/icon/font plus pixel controls cover the result; the PR reports both new browser tests failing with the source reverted. Motion/readiness and corridor fixtures adapt to larger panels. This reduces a parallel sizing policy within ADR 0011/0015's shared-geometry/focus direction. No new perf sweep or native compositing evidence accompanies the larger tiles. |
| [Ten-line paging (#1297)](https://github.com/xnmp/tauri-explorer/pull/1297) | PAGE_LINES is shared by classic navigation and Tiles panels; a panel uses its own columns and paging stays within the cursor's level. Details moves ten entries; classic grids move ten rows. Column-flow List keeps its horizontal paging. Domain outcomes cover bounds, selection intent and panel columns; the PR reports 56 all-view browser cases. Existing explorer selection and FileList reveal ownership remain intact (ADR 0015). |
| [Caret-less double-click (#1300)](https://github.com/xnmp/tauri-explorer/pull/1300) | One rowClickOwnsPeek predicate and explorer input builder govern click toggling and refused folder double-clicks. FileList shows the configured Open key, or the context menu when unbound; Tiles/providers/peek-off retain navigation. Domain, state and browser outcomes cover that boundary with reported revert controls. The eager guard adds a reported 188 gzip bytes; the startup cap rises 512 bytes with a recorded rationale. Preserve that budget change as a cost, not a startup-speed claim. No second input or focus owner is introduced. |

### Filing decision

Rechecked all open/closed `tech-debt` filings: #1206 remains the only labelled
filing and is closed. **Zero** issues filed across this pass; no labels changed.
All five entries remain unexpired on 2026-10-19 and below their existing
triggers. Merge the Tiles sizing/input changes into file-list ownership and
the late-drop correction into drag destination lifetime; preserve expiries.

The six monitored page/file-list files still have 1 / 4 / 1 / 1 / 1 / 5
`fix:` commits both since the prior 2026-09-18 baseline and since 2026-09-19
(the current 30-day date window). #1296 fixes TilePanelsView and its shared
geometry, outside those six paths; #1300 is a feature commit. Neither changes
the defined count trigger. The mock remains 3,226 lines. No backend, vendored
Wry, workflow or governing ADR changed. Recovery has no new checkpoint or
admission bypass, and there is no new renderer/environment policy.

#1283 and #1290 are now closed by #1287 and #1291. Renderer retirement
[#1137](https://github.com/xnmp/tauri-explorer/issues/1137), wider DnD qualification
[#1225](https://github.com/xnmp/tauri-explorer/issues/1225) and native Trash locators
[#1228](https://github.com/xnmp/tauri-explorer/issues/1228) remain open; reuse them.
The unchanged thumbnail loader still permits invalidated in-flight publication
and rejoining (ADR 0008); no new recurrence crosses the file-list trigger.
Earlier List/Tiles measurements remain historical, not measurements of #1296's
larger panel tiles. Native drop-inside-peek, platform delivery and input/compositor
qualification remain outstanding; synthetic handler outcomes do not close them.

## Entries

Historical windows and PR-specific limits remain in the inspection sections
above. Counts here identify their measurement boundary rather than silently
replacing earlier snapshots.

### Native command surface (registration, mock and IPC wrapper) — defer

- **Seam:** command registration in `src-tauri/src/lib.rs`, wrappers in
  `src/lib/api/*`, and browser fakes in `src/lib/api/mock-invoke.ts`.
- **Evidence:** historical drift fixes #117, #472, #868 and #869 precede
  the parity contract in [#917](https://github.com/xnmp/tauri-explorer/pull/917)
  (`tests/api/mock-invoke-parity.test.ts`). #1218 wires new purge/drag commands;
  #1243 adds child-listing fixtures; #1266 adds a delayed-thumbnail fixture.
  No reported parity escape follows #917. This pass changes none of these
  surfaces: `mock-invoke.ts` is still 3,226 lines at the #1301 boundary.
- **Trend:** feature wiring raised touch rate; drift-fix rate remains zero
  since #917. Below the size trigger.
- **Candidate intervention:** split mocks by the existing API domains with a
  dispatch table, retaining parity enumeration of every command.
- **Reconsideration trigger:** a mock/real drift defect that parity misses,
  or `mock-invoke.ts` passing 4,000 lines.
- **Expiry:** 2027-01-16.

### Linux WebKitGTK renderer configuration and child-process environment — defer

- **Seam:** `webkit_renderer.rs` sets app workarounds; user-facing launches
  opt into `child_env::scrub_command` / `scrub_pty` and Windows
  `process_ext::NoConsole` separately.
- **Evidence:** renderer fixes #1057/#1060, #1071/#1077, #1026/#1136 and #1145;
  the [environment leak fix #1141](https://github.com/xnmp/tauri-explorer/pull/1141)
  had CI follow-ups #1178/#1180. Four opt-in scrub sites coexist with direct
  process spawns in about 30 modules (first-pass snapshot). No renderer or
  child-environment policy changed in any incremental window, including #1301.
  [#1137](https://github.com/xnmp/tauri-explorer/issues/1137) remains open, so
  its early expiry has not fired. Frontend spring cleanup is a different seam.
- **Trend:** new since 2026-10-11, driven by WebKitGTK 2.52; no additional
  missed opt-in or third spawn policy observed.
- **Candidate intervention:** one `process_ext` constructor for user-facing
  launches applies both console and environment policy; internal tools keep
  plain `Command`.
- **Reconsideration trigger:** a second environment leak or console-flash
  report from a launch site missing an opt-in, or a third per-spawn policy.
- **Expiry:** 2027-01-16, or earlier once #1137 retires the DFG workaround.

### Durable file recovery (`src-tauri/src/files/recovery/`) — defer

- **Seam:** durable move/copy recovery (first-pass snapshot: 48 Rust files,
  about 14.3k lines); ADR 0018–0020, ADR 0023 and ADR 0026 remain Proposed.
- **Evidence:** consolidation #874/#946 (checkpoint engine), #875 (tree
  removal), #878/#940 (admitted execution) and #880/#943 (Linux-only opt-in)
  precedes fixes #1154 (parent aliases), #1163 (edited record) and
  [coverage #1162](https://github.com/xnmp/tauri-explorer/pull/1162).
  #1210 preserves exact restore identities; #1218 purge reuses admission and
  prepared deletion; #1243 reduces selections before batch APIs. No incremental
  window, including #1301, changes recovery code or its ADR statuses; spring
  adapters continue through existing mutation APIs.
- **Trend:** falling since the 2026-10-01 consolidation; no new bypass.
- **Candidate intervention:** none yet; accept or revise the Proposed ADRs
  before another extraction so later fixes have an agreed contract.
- **Reconsideration trigger:** three recovery `fix:` commits within 30 days
  bypassing the checkpoint engine or admission seam.
- **Expiry:** 2027-01-16.

### File-list views and page shell — defer (watch for regression)

- **Seam:** `src/routes/+page.svelte`, `FileList.svelte`, `FileItem.svelte`,
  `MillerColumns.svelte`, `TilesView.svelte`, `state/explorer.svelte.ts` and
  the listing, viewport, focus and thumbnail resources they consume.
- **Evidence:** first-pass whole-history fix counts in that order were
  60 / 56 / 26 / 24 / 22 / 38. Ownership ADR 0010 (page session), ADR 0011
  (geometry), ADR 0014 (navigation), ADR 0015 (cursor), and retained tabs
  [#1193](https://github.com/xnmp/tauri-explorer/pull/1193) preceded the decline.
  #1243 peeks extend pane-owned listing/observation and publication; #1258,
  #1265 and #1266 share placement/navigation with FileList-owned deferred
  focus. See their inspection rows for performance and platform limits.
  #1282 adds one FileList feedback fix: counts since 2026-09-19 at #1301 are
  **1 / 4 / 1 / 1 / 1 / 5**, using
  `git log <covered-tip> --since=2026-09-19 --no-merges --format='%s' -- <file>`
  and counting subjects starting `fix:`. #1279 repairs only the motion probe.
  [#1276](https://github.com/xnmp/tauri-explorer/pull/1276) repairs cache-key
  matching and mounted reloads, closing #1267; shared `thumbnail-loads`
  (from #1266) still permits stale in-flight publication/join after invalidation.
  [#1272's medians](https://github.com/xnmp/tauri-explorer/issues/1272#issuecomment-6246681704)
  now supply the previously missing performance evidence; they do not remove
  measured overhead or qualify native input. #1285's checked spec adds no
  new runtime evidence. Website peeks have separate fake-data/demo limits.
  [#1296](https://github.com/xnmp/tauri-explorer/pull/1296) removes mini-tile
  sizing in favor of grid TileLayout and per-panel tracks shared with navigation
  and ghosts. #1297 shares paging distance; #1300 shares click ownership.
- **Trend:** monitored counts are unchanged and below the existing trigger.
  Tiles chrome/geometry adds one deployed fix outside those six paths, while
  removing a parallel sizing policy. These short windows do not establish a
  long-term trend. Earlier List/Tiles costs do not measure the new panel size;
  thumbnail in-flight and native-input/compositing gaps remain explicit.
- **Candidate intervention:** extend existing `RefreshTarget`/pane observation
  for repeated child/root publication or lease-cap exceptions; retain the
  shared loader, placement snapshot and identity-bound reveal callbacks for
  renderer changes. For thumbnail invalidation, extend the existing cache-key
  load owner with writer revocation (ADR 0008), not a component-private cache.
- **Reconsideration trigger:** more than 6 `fix:` commits to any one of the
  six monitored page/file-list files within 30 days.
- **Expiry:** 2027-01-16.

### Native drag source ownership and receiver provenance — defer after #1218

- **Seam:** renderer HTML5 intervals (`state/html5-file-drag.svelte.ts`),
  `native_file_drag.rs` / `native_file_drag/linux_html5.rs` and Wry's GTK
  receiver agree on gesture identity/completion. Destination lifetime and
  feedback consume that identity; they cannot establish internal Move authority.
- **Evidence:** [#1098](https://github.com/xnmp/tauri-explorer/pull/1098)
  introduced provenance/completion routing; #1187 adds Wayland intent with a
  [protocol-limited review](https://github.com/xnmp/tauri-explorer/pull/1187#pullrequestreview-5537145086).
  #1095's delivery residual is closed. [#1218](https://github.com/xnmp/tauri-explorer/pull/1218)
  fixes source contexts, negotiation, multi-URI export, row disposal and delayed
  URI identity. The [audit](testing/1217-dnd-coverage-audit.md#new-regression-review)
  found 22,683 synthetic tests green on broken source but three real outcome
  tests red before/green after. [#1227](https://github.com/xnmp/tauri-explorer/pull/1227)
  releases completed strong GTK contexts outside the tracker borrow and expands
  the [required native gate](testing/dnd-acceptance.md) to seven outcomes.
  #1258 feedback retirement and #1268 spring holds retain pinned provenance.
  [#1282](https://github.com/xnmp/tauri-explorer/pull/1282) closes #1269 with
  session-scoped replay/holds, lost-Leave cleanup, background retirement and
  per-session destination captures. Its unique path-set match selects only a
  captured target; `isInternalDrag` still gates source/Move authority.
  Native probes now reject post-end opening and fallback-masked closure;
  no dedicated native drop-inside-peek test or broader platform proof is added.
  [#1287](https://github.com/xnmp/tauri-explorer/pull/1287) closes #1283 by
  always using an ended drag's capture, checking folder existence after claiming
  the drop, excluding external path-set borrowing and retiring captures on Leave.
  #1291 closes #1290's timer cancellation coverage gap; #1293 fixes only browser
  hit-test readiness. Neither changes the native provenance contract.
- **Trend:** frontend destination lifetime has a further deployed correction,
  but Rust/Wry provenance/completion policy is unchanged. #1227 remains the
  one native lifecycle correction after #1218; #1287 adds no alternative native
  identity inference or completion exception. Its intra-PR external destination
  borrowing defect is fixed, with no demonstrated stale internal source/Move
  authority. Physical GNOME Wayland, cross-window and external receiver
  acceptance stays with open [#1225](https://github.com/xnmp/tauri-explorer/issues/1225).
- **Candidate intervention:** extend the exact-session/pinned `SourceSnapshot`
  boundary with a typed source lease (adopt/bind/complete) if transport owners
  accumulate exceptions; keep copy policy separate. Destination lifetime now
  uses the existing capture owner unconditionally after dragend (#1287);
  extend that owner if further destination exceptions recur. Retain real filesystem
  outcomes rather than substitute another synthetic policy matrix.
- **Reconsideration trigger:** two further ownership fixes after #1218 within
  30 days that add alternative identity inference or completion exceptions
  across these layers, or one demonstrated external gesture inheriting stale
  internal Move authority despite the pinned context. Neither is observed at
  this boundary. Unverified platform delivery alone is not proof of that bug.
- **Expiry:** 2027-01-17; drop if 90 days bring no such recurrence, otherwise
  reassess against native evidence before extending.
