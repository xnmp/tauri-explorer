# High-load stress tests

Surfaces issues that only appear under load — not run in the default E2E gate
(slow by design). Run with `bun run test:load` (own Vite server on :1430, so it
can run alongside a normal dev server on :1420).

| Spec | Load profile | What would fail it |
|------|--------------|--------------------|
| `tab-fanout` | 12 tabs, each a git graph of a distinct 300-commit repo | Open-latency degradation as tabs accumulate (>3× first tabs); slow/incorrect tab switches |
| `churn-leak` | 25× open/close tab cycles + 25× graph toggle in one pane (`LOAD_CYCLES=N` to scale) | Retained renderer JS heap exceeds baseline + 25 MiB after forced GC; excludes native resources |
| `large-graph` | Single 5000-commit graph | Slow first 300-commit page, unbounded commit-row DOM while paging to 5000, slow deep-commit selection |
| `cpu-throttle` | 6 graph tabs at 4× CDP CPU throttle (stand-in for a game / many other browser tabs hogging CPU) | Interactions exceeding ~4× the unthrottled budgets |
| `constrained-memory` | 8 tabs × 1000 commits under a 256 MiB V8 old-space cap | Renderer crash or unresponsive tabs (survival test, no timing assertions) |

Design notes:

- **Deterministic synthetic git data**: `mock-invoke.ts` generates N commits per
  `load-repo-<i>` from index arithmetic (no randomness); N via the
  `mockGitCommits` URL query. The default 17-commit mock repo is untouched.
- **Ratio-based budgets** where possible (last-tabs vs first-tabs, throttled vs
  unthrottled) so CI machine variance doesn't flake; absolute budgets are
  deliberately generous.
- **Leak measurement needs both flags**: `--js-flags=--expose-gc` for forced GC
  and `--enable-precise-memory-info` — without the latter,
  `performance.memory` is quantized and heap deltas read as 0 regardless of
  actual behavior. GC is run in 3 passes with settle time; a single pass
  leaves multi-MB of collectable garbage and false-positives the leak check.
- **UI-driven only**: tabs/graphs are opened via real keyboard/mouse paths
  (Ctrl+T, double-click, Ctrl+Alt+G), never by mutating store globals.
- If a run finds a real product issue, file it as its own GitHub issue and mark
  the test `fixme` referencing it — don't widen budgets to make it pass.

These are bounded mock-browser workloads, not proof of leak freedom or a native
launch benchmark. A short post-GC endpoint delta does not establish a long-run
retention slope. The 256 MiB setting caps V8 old space, not total process RSS.
The CPU test applies a real CDP throttle but compares against fixed budgets,
not an unthrottled baseline measured in the same run. Correct tab remounts alone
do not prove a cache hit; retain the separate cache-remount outcome tests that
assert no redundant history request/loading state. Workspace replacement,
plugin churn, native resources and macOS first-presentation/input need separate
acceptance.
