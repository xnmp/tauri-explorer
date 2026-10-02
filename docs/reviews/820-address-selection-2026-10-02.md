# #820 address-bar selection evidence

The implementation now has outcome evidence for all current new-window entry
points. Production window/navigation behavior is unchanged; the new development
probe installs before the initial session listing and holds only the decoded
real listing reply until an exact label/token release.

Linux/WebKitGTK: 10 real native cases pass in 19 seconds under private
Xvfb/Openbox/D-Bus/XDG. They cover fresh/warm requested directories, actual
Ctrl+N and palette actions, an unseeded first response, seeded late validation
after typing, held warm navigation, actual vertical detach and desktop tear-off,
and actual Ctrl+Shift+T closed-window restoration. Every launch checks native
focus before driver switching, full address selection, immediate typing/Enter
to real filesystem content, Escape, and preserved source-window path/selection.

22 focused unit contracts verify bootstrap/probe behavior, including token/path
validation, replacement/abort cleanup and early releases. Both type checks and
the fresh production build with hook-leak guard pass against the current dev
dependencies. Main gzip is 92,178 bytes; startup gzip is 222,563 bytes, both
within their budgets. The test fixture waits for real
startup before pruning restored tabs, reuses xdotool for geometry, and sends
Ctrl+W through native input outside the retiring WebDriver context.

All 21 screenshots were inspected by an independent verifier; the coordinator
also inspected the delayed-selection and late-reply captures. Captions
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
both gaps are closed in the assertions. Fresh native verification passes all
ten cases against source `e0b948e5d2e1a191da23d6cc8fcbb56dbc6e4c16`, based on
dev `746ff6440d16756652cfb77483debd9179e8bbfa`. The exact binary SHA-256 is
`f1eea1f198cf0e8776f4495a763c0c83663178d5ea30e35a340756ea14a1fb3c`;
the spec SHA-256 is
`071b2a7c22ee210706f5380c74dc44b85c7c9b36bdf7527d71e0fa20db7e3f6a`.
The refreshed image provenance retains all 21 hashes and the ten-case native
trace. Actual app, driver and helper environments were admitted on the private
display/profile; cleanup left no surviving private processes or port listeners.
