# Fresh-window diagnostic: 1,500-cycle private-display run

On 2026-09-28, the real Linux Tauri/WebKit diagnostic completed 1,500
`window-workspace` cycles in fresh-window mode. The run exited 0 after
38m 23s. All 1,500 scenario rows say `passed` and `windowMode: "fresh"`,
covering distinct cycle numbers 1–1,500. The worker log records 1,500
`fresh-open` and 1,500 `native-close` requests. The report has no run error
or failure artifact. This is a bounded diagnostic, not the four-hour W6.1
retention run; its late-quarter retention growth fields are null.

The report identifies the same debug/custom-protocol/E2E-hooks binary as the
earlier 450-cycle diagnostic: source commit `4eb9b97e28c22a7b01369b75fa2d9d79d160061d`,
binary SHA-256 `294d2c2aa7bdf7f82edb7bcf26936d5177a7f96e999ced225ba0fe3fd798ad53`,
and seed `fresh-xvfb-1500-20260928`. It used an isolated XDG profile,
private driver port 45541, and Xvfb/Openbox on `DISPLAY=:101`; the user's
desktop was `:0`. Before the long run, a one-cycle native smoke passed on a
private display. During the long run, the app, tauri-driver and
WebKitWebDriver process environments were observed: all inherited
`DISPLAY=:101` and `GDK_BACKEND=x11`, with `WAYLAND_DISPLAY` unset.
The agent verified no task-owned app, driver, Xvfb or Openbox processes
remained after completion.

The ignored local artifacts live in the separate
`.claude/worktrees/fresh-failure-probe` worktree:

| Artifact relative to that worktree | SHA-256 |
| --- | --- |
| `qualification-results/linux-fresh-xvfb-1500-20260928-c1f47c0a68ad.json` | `b348f77eb1d4f15695723eb97345e02100648a3b926767bbd43d2888916d0778` |
| `qualification-results/wdio-fresh-xvfb-1500-20260928-c1f47c0a68ad/native-soak.spec-0-0.log` | `5084c9ca2cd60ae55f380ba096cb4db2570cdb7364c93b7373491742fae0d0a7` |
| `qualification-results/seed-fresh-xvfb-1500-20260928-c1f47c0a68ad/completed-cycle.png` | `08a031f38001637dc4e06ce8f0dca245fdbec953c22714c5d4bc1d1cc357f69f` |

The final screenshot was visually checked for the real `workspace-b` listing.
It is only final-state evidence; the scenario assertions, report and worker
log establish the repeated native operations. The report recorded 1,502
resource samples, 1,533 ms median and 1,733 ms p95 cycle duration. Those
figures do not establish four-hour retention behavior.

An independent Sol audit confirmed the 1,500 sequential fresh outcomes from
the report and worker operations, the absence of worker errors, and the
current binary hash against the preflight manifest. It classified
private-display isolation as **plausible from retained artifacts**: the
wrapper's `DISPLAY=:101` record was retained, but the live `/proc` output for
each child process was not. The source commit is manifest-supplied rather
than cryptographically derivable from the binary, and probe runner/config
copies in the diagnostic worktree are untracked. These limits do not change
the completed native cycle count or establish W2.5 acceptance.

An earlier run on the user's desktop was interrupted after 552 opens and
551 closes so its windows would stop appearing there. It exited 130,
produced no completed report, and captured no failing-label artifact. Its
partial summary is
`qualification-results/fresh-prelaunch-1500-interrupted-summary.json`
(SHA-256 `6f527364123b6148ce6d4bf4325bbbacc386da1e0ecc8fd6c732bb793f963a27`).
The private-display run replaced it as the completed diagnostic.

W2.5 remains open: neither run reproduced a failing fresh label, so neither
produced the required process timeline around session loss. The successful
run does not identify the cause of the hosted WebDriver session losses in
#703/#781 or satisfy final-`dev` W8.1 acceptance.
