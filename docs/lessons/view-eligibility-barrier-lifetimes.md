# File-view eligibility barrier lifetimes

The first-paint barrier must have the same lifetime as the retained Explorer,
not its mounted pane. Tab switching remounts panes without recreating Explorers;
component-owned expiration and paint state restart the hold on every return.
Own the presentation effect root in the Explorer and dispose it on destruction.

Start its directory scope from navigation intent before listing IO. An empty
`currentPath` during the first listing otherwise bypasses the hold, paints the
built-in spinner, then starts another deadline when the listing completes.
Failed navigation must return eligibility to the retained current directory.

Unrestricted discovery represents unknown owners only. Built-in catalogs and
installed manifests supply known owners, including disabled ones. Scoped load
leases remain pending while those owners load, but settlement must override
unrestricted discovery even if manifest IO or another activation never settles.
Package import/style ownership hands off to individual activation ownership
before activation, so siblings cannot mask a failed or disabled owner.

Run these regressions with the production client-compiled state modules: the
ordinary SSR transform omits effects. Browser coverage must observe transient
spinner/list frames and include a delayed initial listing, rather than always
making listing IPC immediate.
