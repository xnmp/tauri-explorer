# Architecture Decision Records

Architecture decisions that govern repository paths are indexed here. Each ADR
declares its scope with a `Governs:` line so changes can cite the applicable
decision during review.

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-native-launcher-lifecycle.md) | Native launcher process lifecycle | Accepted |
| [0002](0002-window-tabs-teardown.md) | Window-tab teardown owns async pane work | Accepted |
| [0003](0003-windows-installer-trust-boundary.md) | Windows installer trust boundary | Accepted |
| [0004](0004-config-watcher-lifecycle.md) | Config watcher lifecycle and symlink refresh | Accepted |
| [0005](0005-github-pr-conversation-boundary.md) | GitHub PR conversation data boundary | Accepted |
| [0006](0006-git-network-cancellation-boundary.md) | Git network cancellation and mutation boundary | Accepted |
| [0007](0007-markdown-frontmatter-preview-boundary.md) | Markdown frontmatter preview boundary | Accepted |
| [0008](0008-resource-and-contribution-ownership.md) | Asynchronous resource and contribution ownership | Accepted |
| [0009](0009-git-observation-leases.md) | Git observation leases, recovery and event ownership | Accepted |
| [0010](0010-page-session-and-core-readiness.md) | Page-session ownership and foreground readiness | Accepted |
| [0011](0011-pane-viewport-geometry.md) | Pane viewport geometry | Accepted |
| [0012](0012-inline-panel-sizing.md) | Inline panel sizing | Accepted |
| [0013](0013-directory-observation-recovery.md) | Directory observation generations, recovery and cache eligibility | Accepted |
| [0014](0014-observed-directory-navigation.md) | Observed directory navigation and snapshot handoff | Accepted |
| [0015](0015-file-list-keyboard-cursor.md) | File-list keyboard cursor and virtualized focus ownership | Accepted |
| [0016](0016-file-mutation-publication.md) | File mutation publication and editor ownership | Accepted |
| [0017](0017-file-batch-outcomes.md) | File batch outcomes and undo progress | Accepted |
| [0018](0018-native-file-history.md) | Native file history and committed mutation receipts | Proposed |
| [0019](0019-exact-trash-recovery.md) | Exact trash receipts and bounded recovery retention | Proposed |
| [0020](0020-durable-file-recovery.md) | Durable artifact ownership, discovery and reconciliation | Proposed |
| [0021](0021-qualification-process-lifecycle.md) | Qualification process lifecycle and artifact boundary | Accepted |
| [0022](0022-native-qualification-cache-lifecycle.md) | Native qualification cache lifecycle | Accepted |
| [0024](0024-mutation-admission-coverage.md) | Mutation admission coverage | Accepted |
