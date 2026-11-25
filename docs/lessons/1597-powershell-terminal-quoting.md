# PowerShell terminal paths were double-quoted (#1597)

The embedded terminal's cd sync and drop/Alt+T path insertion
(`domain/terminal-command.ts`) quoted PowerShell paths with double quotes.
PowerShell expands `$name`, `$(…)` and backtick escapes inside double quotes,
so `cd "C:\$Recycle.Bin"` went to `C:\.Bin`. `cd -Path` also treats `[ ]` as
wildcards, so `D:\Photos [2024]` did not resolve. PowerShell now gets
`cd -LiteralPath '<path>'` and single-quoted insertions through
`powerShellSingleQuote`, which doubles `'` and the typographic quotes
U+2018–U+201B: PowerShell ends a single-quoted string on any of them.
cmd.exe keeps double quotes; its `%VAR%` caveat is documented in the module.
