# Architecture pressure ledger

Seams that repeated fixes keep pressing on, with the smallest intervention that
would remove several of their special cases and the threshold for acting on it.
An architecture pass updates this file. When an entry crosses its trigger, the
pass files at most three `tech-debt` issues (never `ai-ready`; a human chooses
which debt to work). "Defer" is a valid verdict. Drop entries once they expire.

Covered through: c53c2edcd7f4b87e62f09b19b8b303dccb0ed067

Passes: #1205 (first pass, 2026-10-16)

## How the first pass inspected history

There was no earlier ledger, so #1205 covered the whole `dev` history
(2026-01-11 to the commit above, 2,655 commits). It counted per-file churn of
`fix:` commits for the whole history, then for before 2026-06-17, 2026-06-17 → 2026-08-17
and 2026-08-17 → the tip, to see which way each seam is trending. It then read the
commits, PRs and code behind the top seams. The v1.10–v1.11.2 range had already
been swept by the tech-debt tracker #895 (31 children, all closed by
2026-10-01), so this pass did not re-file anything that tracker resolved. Its
detailed reading starts from that sweep.

Command used for the churn counts (source files only):

```sh
git log --since=<date> --until=<date> --no-merges --format='@@%H %s' --name-only \
  | awk '/^@@/{split($0,a," ");fix=(a[2] ~ /^fix/);next}
         NF&&fix&&/^(src|src-tauri)\//{c[$0]++} END{for(f in c)print c[f],f}' \
  | sort -rn
```

## Entries

### Preview pane content dispatch — intervention filed

- **Seam:** `src/lib/components/PreviewPane.svelte` decides how each file kind
  is previewed and owns the lifecycle of each kind. That content is about a
  dozen parallel nullable `$state` fields, reset by hand in `loadPreview`.
  `rendersAsImage` repeats the order of the loader's dispatch so the previous
  image can be held between images.
- **Evidence:** this file has the most `fix:` commits since 2026-08-17 (12,
  where the next file has 10). Its rate held steady (16 before 2026-06-17, 14
  from 2026-06-17 to 2026-08-17, 12 since then) while the other early hotspots
  fell. There were 17 commits from 2026-10-03 to 2026-10-16. Cross-format state fixes: #1024 (image held between images, which
  introduced `rendersAsImage`), #1129/#1014 (image cache took blob ownership),
  #1054/#1067 (rendition and full-resolution upgrade), #1169/#1192 (settled
  selection during marquee). Layout and mode fixes in the same component:
  #1121, #1127/#1039, #1153, #1033/#1034, #1142. New formats arrived in the
  same period: #971 video, #1140/#1190 codec and sound, #667 CSV, #1015/#1018
  plugin Preview targets.
- **Trend:** sustained, and now first in the repository.
- **Candidate intervention:** a pure `classifyPreview(file)` in `domain/`,
  shared by the loader and the hold-image decision, plus a single
  `PreviewContent` discriminated union produced by a testable
  `state/preview-content.ts`. Fullscreen, dock geometry and diff mode are out
  of scope.
- **Reconsideration trigger:** more than 8 `fix:` commits to the file within 60
  days, with at least two caused by cross-format state (here #1067 and #1192;
  #1024 and #1129 show the same pressure but were not titled `fix:`). **Crossed**, so it is
  filed as #1206.
- **Expiry:** close this entry when #1206 lands. If #1206 is still unscheduled
  on 2027-01-16, re-check the trend before keeping the entry.

### Native command surface (registration, mock and IPC wrapper) — defer

- **Seam:** each Tauri command is registered in `src-tauri/src/lib.rs`, wrapped
  in `src/lib/api/*`, and faked in `src/lib/api/mock-invoke.ts` (3,193 lines)
  for browser E2E.
- **Evidence:** `lib.rs` (10) and `mock-invoke.ts` (9) are the next most-fixed
  files since 2026-08-17. Across the three periods above they had 25 / 17 / 10
  and 14 / 23 / 9 `fix:` commits. Almost every feature since 2026-10-01 touched both of
  them (#1048, #1088, #1090, #1109, #1140, #1183, #1185, #1190). Earlier
  mock-drift fixes: #117, the 2026-05-13 unmocked-commands fix, #472, #868,
  #869. Since the parity contract `tests/api/mock-invoke-parity.test.ts`
  (#869 via #917) landed, no drift fix has been needed.
- **Trend:** the touch rate is rising with feature work; the drift-fix rate has
  fallen to zero since #917. The changes to `lib.rs` are wiring, not defects.
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
  #1079/#1141 had two CI follow-ups (#1178, #1180). The scrub is opt-in at
  four call sites (`terminal.rs`, `system.rs`, `files/external_apps.rs`, and
  the `system.rs` launcher loop), while about 30 other modules spawn
  processes directly.
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
  coverage work #1162.
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
  0015 (keyboard cursor), and the retained-tab work in #1173 (landed as #1193).
- **Trend:** falling.
- **Candidate intervention:** none; the ADRs above are the intervention.
- **Reconsideration trigger:** more than 6 `fix:` commits to any one of these
  files within 30 days.
- **Expiry:** 2027-01-16.
