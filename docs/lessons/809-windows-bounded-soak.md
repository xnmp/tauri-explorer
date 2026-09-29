# 809 — Keep bounded Windows soak evidence separate from long retention

The native soak runner already supports WebView2 attachment and Windows process
measurement. Its CI job now builds through the qualification builder, which
requires a clean source tree and records the exact binary digest and commit.
The runner verifies that manifest before launching the application.

A fixed seed and `SOAK_MAX_CYCLES=1` exercise one complete cycle of window churn,
plugin enable/disable, theme and zoom interaction, and native preview input.
Clean qualification profiles start with the preview closed, so the preview
scenario must open it after keyboard selection before asserting native content.
This is platform acceptance, not evidence of four-hour retention. The separate
Linux long-session run still needs its full duration and recorded report.

Soak fixtures use the native runner's ownership root. Cleanup happens after the
application and driver exit, avoiding removal while Windows still owns native
directory handles. Reports, resource samples, failure captures, and driver logs
are retained even when the job fails.

The [bounded Windows job](https://github.com/xnmp/tauri-explorer/actions/runs/36295698690/job/108554012406)
passed on synthetic PR checkout `cc2ad619` (branch `74596540` merged into
then-`dev` `6e12430c`). Its verified binary hash is
`038fc30c52fded3c00c35ab550e9b854673b7b6e142016d4ffe272721b84e77d`.
All four declared scenarios passed once, with six RSS samples, display scale
one, and no report errors. `SOAK_MAX_CYCLES=1` ended the run after 14.7 seconds;
the configured ten-minute duration is a ceiling, not an elapsed-time claim.
The completion screenshot shows a real Windows listing and Markdown preview.
WebView2 emitted teardown diagnostics after the screenshot was captured; the
report and WDIO outcome passed. The separate Windows smoke job still failed
the known #710 tear-off adoption case on this base, so the bounded result does
not qualify the full Windows native suite.
