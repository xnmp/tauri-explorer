# #965: Driver exit precedes transcript completion

The Linux WDIO runner ended its piped tauri-driver log on `exit`. Node can still
emit stdout/stderr afterward, so the runner could lose diagnostic tails or raise
`ERR_STREAM_WRITE_AFTER_END`. A failed spawn emits `error` then `close` without
necessarily emitting `exit`, leaving the transcript unfinished.

Finalize the log on child `close`; successful owned-process cleanup also awaits
stream completion. Preserve process cleanup errors instead of waiting for a log
from a process that could not be stopped. Report log-write errors best effort.
ADR 0021 governs this lifecycle.

`tests/wdio-driver-transcript.test.ts` imports the production WDIO configuration
and exercises output arriving after exit, failed-spawn finalization, deferred
final log writes, and preservation of the primary cleanup error. Before the fix,
the first case rejected with `write after end`, the failed-spawn case timed out,
and the delayed-write case reported cleanup complete too soon.

This extracts the remaining useful fix from #634. The original Windows session
problem and embedded frontend work were superseded by #655 and earlier merges.
