# 1099: shared Preview actions must be admitted against the owning pane

Preview is window-global, so it sits outside ExplorerPane's inert base content. Its
Stage/Unstage/Discard (and hunk) controls therefore bypassed pane dialogs. Route every
repository mutation through `state/preview-diff-actions.ts`, which checks
`dialogStore.isPaneBlocked(owner)` — never a private dialog-state check — and disable the
buttons from the same predicate (re-evaluated via `subscribeOwnership`).
