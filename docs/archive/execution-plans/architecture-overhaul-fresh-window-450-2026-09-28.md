# Fresh-window prelaunch diagnostic: 450-cycle local run

On 2026-09-28, the real Linux Tauri/WebKit diagnostic completed 450
`window-workspace` cycles in fresh-window mode. It ran for 576.5 seconds and
exited 0. All 450 scenario rows, including cycle 399, say `passed` and
`windowMode: "fresh"`; the report contains no failed scenario, run error, or
failure artifact. This is a bounded diagnostic, not the four-hour W6.1 run.

The harness checkout was `6ef62cd1`, whose changes after the native build are
documentation only. The verified debug/custom-protocol/E2E-hooks binary came
from source `4eb9b97e28c22a7b01369b75fa2d9d79d160061d`, at
`src-tauri/target/debug/tauri-explorer` in the repository checkout.
The manifest, report, and current binary agree on SHA-256
`294d2c2aa7bdf7f82edb7bcf26936d5177a7f96e999ced225ba0fe3fd798ad53`.
The run used an isolated XDG profile under `qualification-results/`, display
scale 1, and seed `fresh-prelaunch-450-20260928`. The report records 452
resource samples, 1,281 ms median and 1,470 ms p95 scenario duration. Its
late-quarter RSS and shared-memory FD growth fields are null because the run
is shorter than the four-hour retention interval; those are not passed
retention checks.

The ignored local evidence is:

| Artifact | SHA-256 |
| --- | --- |
| `qualification-results/linux-fresh-prelaunch-450-20260928-300ffc4d477e.json` | `725c2928af32544ca0dd3f6d46b9cf41b39494bd066ead55b43d0931c2e2eb4e` |
| `qualification-results/linux-fresh-prelaunch-450-20260928-300ffc4d477e-webdriver.log` | `875ffaae8cb0a326d6b410d68864fbbe801c36c2586f55eb4c3b3b4b9cd1429b` |
| `qualification-results/wdio-fresh-prelaunch-450-20260928-300ffc4d477e/native-soak.spec-0-0.log` | `9d492264d7db401eb319db197ecf685c1911d3b824e8996873410553a8dcc487` |
| `qualification-results/seed-fresh-prelaunch-450-20260928-300ffc4d477e/completed-cycle.png` | `4b6ce98fb1964a9d1f8c8e11278164adacad5c357d6f3b2ae18fd316f29fcf1c` |
| `/tmp/fresh-prelaunch-450-20260928.log` | `e851baa08693a058682c016e16654588bd1e59f967a7a1f24da23d86c9af5a96` |

The completed-cycle screenshot was visually checked: it shows the real
Explorer listing for `workspace-b`, including `interruptions.txt`. The
scenario also asserted the current listing and navigation on every cycle;
the screenshot alone is only a final-state check. No process-timeline JSON was
expected because no fresh-open operation failed.

An independent Sol read-only audit counted 450 `fresh-open` and 450
`native-close` requests in the worker log and confirmed the report, manifest,
binary hash and screenshot agree. That establishes the recorded native
exercise within the harness's limits; there is no separate per-cycle image or
external observer for every child window. The controlled build manifest gives
source provenance, but the artifacts alone cannot prove the compiled bytes'
source cryptographically.

W2.5 remains open. The required evidence is a process timeline for a **failing**
fresh label around an actual session loss. This successful run does not create
that artifact or prove the older cycle-399 failure's root cause. The diagnostic
also has no bearing on unpublished Windows/macOS gates or final-`dev` W8.1.
