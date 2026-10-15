# 1202 — Windows clipboard fixture array conversion

The reported dev run passed Linux smoke and Windows Rust contracts/lint. Windows
smoke failed in the cross-window clipboard spec's external WinForms fixture,
before its independent native reader ran. The empty-list case called
`SetFileDropList` with an empty string; the ordered multi-file case called it
with both paths joined by a space. The single Unicode path case passed.

Windows PowerShell 5.1 emits the array returned by `ConvertFrom-Json` as one
pipeline object. Wrapping that output in `@(...)` creates a nested array.
Casting that nested array to `[string[]]` for `StringCollection.AddRange` turns
the inner array into one string instead of preserving its members.

Assign the JSON result directly to `[string[]]$paths`. The existing zero-count
branch then seeds text (no CF_HDROP), while single and multiple paths reach
WinForms unchanged and in order. All three native reader assertions retain
their exact expected arrays. Cross-window Copy/Cut, external replacement,
closing-originator publication and on-disk Paste checks are unchanged.

The last green run preceded the retained-tab change, clipboard reader/fixture
change, CI admission change and report-attachment change. The bad fixture was
introduced with the clipboard reader fix (#1195); intervening Windows runs were
cancelled. The report-attachment commit named by this issue does not touch this
fixture. Reverting the clipboard fix would restore the previously observed
`Get-Clipboard` stall, so fix the fixture forward.

Reproduction used the actual inline seeder script with only WinForms replaced by
a recording class. PowerShell 7's `ConvertFrom-Json -NoEnumerate` reproduced the
Windows PowerShell 5.1 output contract: the original script recorded `[""]` and
one space-joined path, failing two of the three existing payload cases. After
the direct assignment, all three exact arrays passed. This isolates conversion;
it does not substitute for real Windows clipboard qualification. The existing
Windows smoke cases exercise WinForms and the independent CF_HDROP reader on
the hosted desktop. No workflow, test deadline, retry or assertion changed.
