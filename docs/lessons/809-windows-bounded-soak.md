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
are retained even when the job fails. Acceptance remains pending until the
Windows runner executes every scenario and produces a passing report.
