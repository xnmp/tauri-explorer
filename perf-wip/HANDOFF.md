# #1417 WIP checkpoint (paused for machine shutdown, 2026-10-28 ~00:30)

The agent was stopped mid-way through its final adversarial review; it had not
written its own report. State at pause:
- Implementation edits (see the commit diff) cover: a compact directory wire
  format (src-tauri/src/files/directory_wire.rs <-> src/lib/api/directory-wire.ts,
  fixture tests/fixtures/directory-wire.json), per-phase load diagnostics
  (src-tauri/src/load_diagnostics/*, src/lib/domain/load-diagnostics.ts),
  a listing reaper (src-tauri/src/files/listing_reaper.rs), frontend sort/
  selection changes, perf runner updates and docs/performance.md /
  docs/lessons/1417-large-folder-pipeline.md drafts.
- The final interleaved A/B (fin-base-*, fin-fix-*) and memory runs
  (mem-base*) completed; their small result files are copied here (perf-wip/).
  Release binaries and the review scratch (679 MB) lived in /tmp and are lost.
- .prof.mjs / .profsum.mjs are the agent's ad-hoc profiling helpers — delete
  before the real commit unless promoted into scripts/.

## Next steps
1. Read the diff and perf-wip/*.json; re-run the adversarial review (wire
   format/decoder correctness, sort equivalence, refresh interleavings,
   listing reaper lifetime, perf claims).
2. Re-verify: bun run check, lint:arch, check:bundle, vitest, cargo fmt/clippy/
   tests (xvfb-run), Playwright navigation/sort/peek specs (ALL_VIEW_MODES).
3. Merge origin/dev (the base PR #1421 was squash-merged), drop perf-wip/ and
   the .prof helpers, squash the WIP commit, push, PR "Closes #1417".
