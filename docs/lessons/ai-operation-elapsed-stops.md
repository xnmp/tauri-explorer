# A settled AI job's duration must end at settlement, not at its last update

- `JobRecord.updated_at_ms` moves on every mutation, including ones after a job settled (Dismiss turns a stopped job into `Discarded`). The Background Jobs and progress panels used it as the job's end, so the displayed duration kept growing.
- `settled_at_ms` is stamped once, when a row first becomes retained (terminal or parked by Stop/Discard), and survives later changes. Rows settled before it existed have none: show no duration, never fall back to `updated_at_ms` or the clock.
- The rule lives in `jobDuration` (`domain/image-job-progress.ts`): active is now - start, settled is the frozen end - start, a missing end is `null`. Tick timers only while some job is unsettled.
