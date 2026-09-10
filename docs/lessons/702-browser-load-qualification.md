# 702 — browser load qualification: what four workers actually exposed

Nine Chromium outcomes failed once under `ALL_VIEW_MODES=1` with four workers
and passed on a one-worker rerun (#702). None of them was CPU load "making a
good test fail". Three distinct defects were reproduced under repeated
four-worker load; two are application ordering bugs' test-visible symptoms and
one is a genuine product defect that a user hits with a fast click.

## Reproduction recipe

A throwaway Playwright config on a private port with
`trace: "retain-on-failure"`, then:

```
ALL_VIEW_MODES=1 nice -n 19 ionice -c3 npx playwright test \
  --config=<throwaway>.config.ts --workers=4 --repeat-each=20 \
  --output=<run-dir> e2e/scm-diff-view.spec.ts e2e/git-graph-cache-remount.spec.ts
```

Rates observed on this machine (load average ≈ 3 before the run):

| case | reproduced |
| --- | --- |
| `git-graph-cache-remount.spec.ts` "paginate to its oldest commit" | 6 / 20 |
| `scm-diff-view.spec.ts` (`openScmOnRepo`) | 3 / 90 across two runs |
| `git-graph-undo.spec.ts:241` (`navigateToPath`) | 1 / 6 |

Playwright wipes `outputDir` at the start of every run, so pass `--output=` a
fresh directory per reproduction or the traces you just captured are deleted by
the next run.

## 1. Quick Access rows built on a placeholder home — product defect

`FilesSidebarView` derived its five default rows from
`homeDirectory.value ?? "/home"`. `homeDirectory.value` is null until the
one-time `get_home_directory` IPC resolves, so for the first frames the sidebar
renders **navigable** rows pointing at `/home/Documents`, `/home/Downloads`, …
Anything that clicks in that window navigates to a path that does not exist and
the pane parks on "Path not found: /home/Documents" — permanently, because
nothing re-navigates. That is what the trace showed, with the `Documents`
bookmark still marked active against the bogus path.

Four workers only widened the window; the same click is available to a user on a
slow machine, and on a real system home is never `/home`.

Rule: a placeholder is acceptable for *display*, never for a control that
navigates. Default Quick Access rows now come from `domain/quick-access.ts`,
which gives every row a **null path** while the home directory is unknown, and
joins with `joinPath` so a Windows home stays all-backslash. The rows still
render (`aria-disabled`, no `data-path`, click and Enter/Space are no-ops), so
the section keeps its shape.

Dropping the rows entirely was the first attempt and broke
`recycle-bin-sidebar.spec.ts`: it asserts the Recycle Bin item has a previous
sibling, and with an empty Quick Access section it became the first child. That
failure was worth having — it is the same visible layout jump a user would see
when the five rows appear above the Recycle Bin a frame later. Withhold the
*target*, not the row.

## 2. Pagination paced on a spinner that is never observed — fixture defect

`scrollToOldestSyntheticCommit` scrolled the graph to the bottom at most five
times, waiting after each scroll for `git-graph-loading-more` to be *hidden*.
It never waited for it to be *shown*, and `handleScroll` drops a near-bottom
load request whenever `loading` is true (an initial query or an append already
in flight). Instrumenting the loop showed each pass returning in 60–98 ms with
`loadingMore` observed as `false` on both sides of the wait — the spinner was
never actually seen. A refresh (F5) that is still replacing page zero when the
loop starts therefore consumes every one of the five scrolls in under a second
without loading anything, and the final 10 s assertion then waits with no
further scroll to unstick it. 750 commits at `PAGE_SIZE` 300 need three real
passes, so the budget only had two to spare.

The loop now re-issues the scroll on every poll pass and paces on the outcome —
the oldest commit becoming reachable — so a dropped request is always retried
while a cursor that genuinely stops at the cached prefix still fails.

## 3. Address bar Enter consumed by autocomplete — fixture defect (and a product smell)

`git-graph-undo.spec.ts`'s `navigateToPath` filled `.path-input`, sampled
`.suggestions-dropdown` visibility **once**, then pressed Enter.
`BreadcrumbAutocomplete` debounces its directory fetch by 150 ms and sets
`selectedIndex = 0` when it returns, and its Enter handler prefers
`applySuggestion` over `confirm` whenever a suggestion is selected. Normally the
Enter beats the debounce; under load the list opens first, Enter rewrites the
input to the first child (`…/load-repo-0/src/`) instead of navigating, the pane
stays on the old repository and the address bar keeps focus — so the next
`Control+Shift+p` went into the text box and the graph never opened.

The helper now commits against the pane's own reported location
(`.file-list .content[data-current-path]`) instead of assuming one Enter worked.

Product smell, deliberately not changed here: typing a complete, valid directory
path and pressing Enter navigates into that directory's *first child*, because
the first suggestion is auto-selected. Worth its own issue.

## Method notes

- `--repeat-each` at four workers reproduces far better than a full-suite run:
  the nine specs contending only with each other failed at similar rates.
- The Playwright trace's `error-context.md` ARIA snapshot answered both
  ordering questions on its own (the bogus path in the pane, the address bar
  still in edit mode holding a completed path). Read it before opening the
  trace viewer.
- Six of the nine originally listed outcomes did not reproduce in ~21
  four-worker repeats each plus two full `ALL_VIEW_MODES=1` suite runs, and were
  left untouched: `git-command-palette:12`,
  `git-graph-base-update-merges:13`, `git-graph-branch-line-jump:59`,
  `git-graph-undo:180`, `git-graph:78`, `tiles-rename-no-shift:12`.
- `e2e/performance.spec.ts` and `e2e/preview-resize-contract.spec.ts` fail in a
  contended full-suite run and pass at `--repeat-each=3` in isolation. That is
  the documented CPU-contention flake mode, not a regression — check in
  isolation before treating either as one.
