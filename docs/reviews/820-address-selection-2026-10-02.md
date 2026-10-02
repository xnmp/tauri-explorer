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
