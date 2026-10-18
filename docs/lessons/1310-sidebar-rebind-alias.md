# #1310 — Sidebar rebinding left another command on the old chord

Toggle Sidebar (`view.toggleSidebar`) and Toggle Files Sidebar (`view.focusFilesSidebar`) are separate commands. Rebinding the first never modified the second. The reported profile had Ctrl+Alt+I on Toggle Sidebar and the obsolete Alt+M T default retained on Toggle Files Sidebar.

The one-time legacy migration in #1309 removes the obsolete alias binding while preserving the canonical rebind. An end-to-end regression reproduces that exact profile, hides the sidebar with Ctrl+Alt+I, and verifies Alt+M T opens the terminal without reopening the sidebar. A reload regression verifies later deliberate alias bindings are not migrated again.
