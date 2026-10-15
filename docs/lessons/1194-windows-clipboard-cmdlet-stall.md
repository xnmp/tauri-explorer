# 1194 — Independent Windows clipboard cmdlet stall

The first failing dev smoke run completed 58 of 59 spec files successfully.
Linux smoke, Windows native contracts and Windows clippy passed. The sole
failure was the first independent clipboard read in the cross-window ownership
spec: both app publications had completed, and the PowerShell-ready stderr
marker appeared, but `Get-Clipboard -Format FileDropList` never returned before
the existing 30-second process deadline. Later reads in that session succeeded.

The only merge since the last green run was #1193's retained-tab rendering.
The failing case had not created or switched window tabs, and native publication
had already settled. Reverting retained tabs would not remove the failing
clipboard cmdlet. Fix forward at the independent observation boundary instead.

The Windows reader now loads a small PowerShell/C# probe of the eager CF_HDROP
payload using OpenClipboard, GetClipboardData and Unicode DragQueryFileW. It
avoids the Shell clipboard cmdlet, returns an array even for zero or one path,
fails on native errors/incomplete paths, and releases the clipboard in finally.
It stays outside the application process and does not read application state.
External Copy, X11 probes, process timeouts and failure diagnostics are unchanged.
This removes the observed stalled dependency; the artifact does not establish
which internal PowerShell/Shell operation blocked.

The command-contract regression failed against the old reader before the fix.
The real native spec also seeds empty, single and ordered multi-file payloads
through external WinForms, including Unicode, spaces, quotes and dollar signs,
and checks the reader's exact paths. Each payload has its own unchanged
60-second test budget, so six successful cold shells cannot exhaust one test's
deadline. Its existing app-driven cross-window Copy,
Cut, external replacement, closing-originator and on-disk Paste assertions remain
intact. Windows adapter qualification runs on the hosted disposable desktop;
local mocked process tests establish dispatch/serialization, not Win32 behavior.
