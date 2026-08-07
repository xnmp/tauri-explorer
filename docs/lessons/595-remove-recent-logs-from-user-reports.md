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

## Guard

`user_report_body_never_carries_a_log_tail` asserts the assembled body ends at
the environment block, with no fence and no log text.
