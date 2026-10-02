# #820 address-bar selection evidence

The implementation now has outcome evidence for all current new-window entry
points. Production window/navigation behavior is unchanged; the new development
probe installs before the initial session listing and holds only the decoded
real listing reply until an exact label/token release.

Linux/WebKitGTK: 10 real native cases pass in 20.3 seconds under private
Xvfb/Openbox/D-Bus/XDG. They cover fresh/warm requested directories, actual
Ctrl+N and palette actions, an unseeded first response, seeded late validation
after typing, held warm navigation, actual vertical detach and desktop tear-off,
and actual Ctrl+Shift+T closed-window restoration. Every launch checks native
focus before driver switching, full address selection, immediate typing/Enter
to real filesystem content, Escape, and preserved source-window path/selection.

23 unit contracts verify bootstrap/probe/focus behavior, including token/path
validation, replacement/abort cleanup and early releases. Both type checks and
the production build with hook-leak guard pass. The test fixture waits for real
startup before pruning restored tabs, reuses xdotool for geometry, and sends
Ctrl+W through native input outside the retiring WebDriver context.

All 21 screenshots were inspected independently and by the coordinator. Captions
and exact binary/test/image hashes are in
`screenshots/test/820-highlight-address-bar-on-making-new-window/`.
Six representative image-only proofs are in `evidence/820/`. Still images alone
do not prove native focus, reply timing or selection offsets; the native
assertions supply those outcomes. No host desktop or clipboard was used.

There is no folder context-menu New Window action in this version. Current
requested-directory cases qualify the shared launcher rather than asserting a
nonexistent UI action. Hosted CI and required PR review remain merge gates.

## Qualification limits and assertion refresh

The recorded ten-case run above used `debug-custom-protocol-e2e-hooks`. Hook
builds load the listing observer before creating the session; release builds
start the session synchronously. The observer holds decoded replies from the
real backend, but equivalence with release startup timing remains supported
by source rather than a direct release-runtime test.

Independent audit found that the original unseeded first-response case checked
only that native focus left the source before switching the driver, and checked
the target title afterward. It also inferred the warm child's invisibility
during the hold from source ordering. The spec now checks the requested native
title before that first switch and directly asserts the exact warm label exists
and remains invisible while its reply is held. Independent review confirms
both gaps are closed in the assertions. Fresh native verification of those
strengthened assertions is pending; the earlier run is retained as earlier
evidence, without claiming it performed the new checks.
