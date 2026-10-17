# Architecture pressure ledger

Seams that repeated fixes keep pressing on, with the smallest intervention that
would remove several of their special cases and the threshold for acting on it.
An architecture pass updates this file. When an entry crosses its trigger, the
pass files at most three `tech-debt` issues (never `ai-ready`; a human chooses
which debt to work). "Defer" is a valid verdict. Drop entries once they expire.

Covered through: ebd351f3f4149e294fbff621137c124e33e7146b

Passes: [#1205](https://github.com/xnmp/tauri-explorer/issues/1205)
(first pass, 2026-10-16), [#1219](https://github.com/xnmp/tauri-explorer/issues/1219)
(incremental pass, 2026-10-17).

Post-pass correction (#1223): #1218 was reverted to restore the startup bundle
budget after its merge failed CI. References below describe the inspected
historical snapshot, not the current implementation. In particular, the native
drag adapter and real row-to-folder transfer coverage from #1218 are absent
again; re-evaluate that seam when the change is reintroduced.

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

## Entries

Undated historical churn counts below are the first pass's snapshots at its
boundary; this pass's measurements and incremental evidence are identified
separately.

### Native command surface (registration, mock and IPC wrapper) — defer

- **Seam:** each Tauri command is registered in `src-tauri/src/lib.rs`, wrapped
  in `src/lib/api/*`, and faked in `src/lib/api/mock-invoke.ts` (3,212 lines)
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
- **Trend:** below the existing trigger in every file; retain the falling
  first-pass assessment, but one day's incremental window cannot establish a
  new long-term trend.
- **Candidate intervention:** none; the ADRs above are the intervention.
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
  [coverage audit in the reverted PR](https://github.com/xnmp/tauri-explorer/pull/1218/files)
  reports 22,683 synthetic tests green on broken source, then the same three
  real native outcome tests red before and green after the fix. Historical
  controls refute attributing onset to #1098; they use today's GTK runtime,
  not historical platform builds.
- **Trend:** repeated native ownership/intent changes in October; #1218 adds
  a dedicated adapter and real GTK X11 transfer coverage, so observe that
  intervention before proposing another extraction. Physical GNOME Wayland,
  cross-window and external-application delivery remain unqualified by those
  three GUI cases; Rust/protocol contracts cover narrower interleavings.
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
