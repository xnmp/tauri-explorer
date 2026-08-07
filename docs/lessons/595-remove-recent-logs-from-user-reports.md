# #595 — "Recent logs" made every in-app report worse

## Symptom

Every issue submitted through Report Issue ended with a `## Recent logs` fence
holding the last 50 lines of the rotating log. In practice those lines were
always background chatter unrelated to the report — `gitstat` badge probes,
thumbnail decode timings — because they are captured *at submit time*, which is
minutes after whatever the reporter is describing.

## Why it was wrong by construction

A log tail is only evidence if it is anchored to the failure. `submit_user_report`
read the tail at the moment the user pressed Submit, so the sampling window was
"the last few seconds of idle app", never "the moment of the bug". The section
therefore had a fixed cost (noise burying the reporter's own words, and up to
8000 UTF-16 units of relay budget spent on it) and no upside.

## Fix

`assemble_issue_body` no longer takes a `log_tail` argument at all — the
parameter is gone rather than passed `None`, so no future caller can reintroduce
the section by accident. `submit_user_report` dropped its `AppHandle` parameter
with it (it existed only to reach `read_log_tail`).

Logs remain reachable deliberately: Command Palette → "Open Logs Folder".

## The second implementation had to go too

Removing the parameter from the *relay* path left a complete parallel path still
armed: the pre-#575 "open a pre-filled GitHub issue" flow (`bugReportUrl` in
`src/lib/api/crash.ts`) built its own body with a `## Recent logs` fence via
`recentLogsSection`, fed by `readLogTail` → the Rust `read_log_tail` command.
After #575 that flow had no production callers, only tests — so it read as
"still supported" while being unreachable and unguarded.

A dead second implementation of exactly the behaviour you just removed is worse
than no cleanup: the next person wiring a report path finds a working helper
that reintroduces the reported bug with nothing failing. All of it is deleted —
`readLogTail`, `bugReportUrl`, `recentLogsSection`, `RECENT_LOGS_HEADING`, the
`read_log_tail` Tauri command and its registration, and the mock-invoke handler.

**Lesson:** when a fix is "stop collecting X", grep for every producer of X, not
just the one on the call path you edited.

## What actually guards this

The guard is structural, not assertional: `assemble_issue_body` has no log-tail
parameter and there is no longer any code in either language that reads a log
tail. `user_report_body_never_carries_a_log_tail` pins the full rendered body
with `assert_eq!`, so any newly added machine-collected section shows up as a
diff — but a `!contains("```")`-style assertion would prove nothing, since a
reporter's own description may legitimately contain a fence.
