# Git graph session undo (#513)

- Record undo state at the mutation producer. The Rust command that deletes or
  moves a ref knows the exact pre/post OIDs; reconstructing them later from
  rendered chips makes stale UI state part of a safety decision.
- Treat every undo snapshot as an expected post-state, not just inverse
  instructions. Deleted refs must still be absent, renamed refs must retain
  their captured target, and merge/pull undo requires the same branch, exact
  post-operation HEAD, and a clean index/worktree.
- Recheck inside the authoritative backend command immediately before the
  inverse. A frontend preflight is useful for wording but cannot protect the
  check-to-IPC interval.
- Preserve raw tag-object OIDs. Peeling an annotated tag to its commit and
  recreating it with `git tag <name> <commit>` silently downgrades it to a
  lightweight tag; restoring the original ref target retains the annotation.
- Shared shortcuts need mutually exclusive command predicates. Ctrl+Z remains
  file undo outside the graph and routes through a pane-id request bus inside
  the active graph, matching the existing F5/branch-navigation ownership model.
- Browser mocks must mutate the same ref map that renders the graph. A no-op
  mock can prove a toast fired, but cannot prove a deleted chip disappeared or
  returned to its original commit after undo.
