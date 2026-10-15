# 1188 — Windows clipboard smoke probe timeout

The failing Windows smoke run stopped the first cross-window Copy test at the
independent `nativePaths()` call: no WebDriver commands occurred between its
preceding response and the failure 10.06 seconds later. Both native publications
had already completed. Linux smoke, Windows Rust contracts and lint passed.
The sole intervening call was `execFileSync("powershell", ...)`, with a ten-second
timeout. The only PR since the last green smoke changed Linux Wayland ownership,
so reverting it would not address this Windows probe.

A local Node reproduction with a deliberately stalled child confirmed that
`execFileSync` timeout errors have `error.error === error`. WebdriverIO serializes
own error properties while checking for skipped tests; this replaces the original
failure with `Converting circular structure to JSON`, bypassing `afterTest` and
its retained outcome record.

The independent clipboard reader and external Copy now use awaited `execFile`
on Windows, with one bounded 30-second budget including cold shell/module startup.
There is no retry. PowerShell errors terminate the command; a stderr readiness
marker distinguishes shell startup from clipboard-command execution if it times
out again. Failures become plain Errors containing bounded stdout/stderr plus
code and signal, so WDIO can report the actual failure. This is a defensive fix
for the observed subprocess deadline; the original artifact cannot distinguish
cold shell startup from a stalled Get-Clipboard call.

The native spec still asserts the actual OS paths and exact on-disk Paste bytes
from both windows, Cut source removal, external Copy precedence, and publication
after the originating window closes. X11 selection-owner handling stays intact.
Deterministic probe contracts simulate a 12-second cold shell, a circular timeout,
malformed output, and literal external Copy paths. The extracted original
synchronous implementation fails those contracts. Windows GUI qualification
remains in the existing dev-push smoke workflow; no retries or skips were added.
