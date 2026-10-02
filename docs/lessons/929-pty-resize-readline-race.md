# #929 — A PTY resize lost to readline's prompt preparation

**Symptom.** `pty_round_trips_input_resizes_and_reaps_the_shell` failed
intermittently on macOS CI: after `resize_terminal(…, 132, 40)` the next
`stty size` still printed `24 80`.

**Cause.** Not the #920 input sequencer: with a distinct marker per write,
`SIZE1=` and `SIZE2=` each appeared once. Not asynchronous delivery either:
reading `TIOCGWINSZ` back on the master straight after the successful resize
already returned 24×80, and it stayed 24×80. Readline's `set_winsize`
(`rltty.c`, called from `get_tty_settings` whenever it prepares a line) reads
the window size and writes the same value straight back. The test resized as
soon as the first `stty` printed, while the shell was reclaiming the terminal
for its next prompt. A resize that lands between that read and write is
overwritten with the stale size. A macOS loop hit this 2 times in 40 isolated
runs. The window exists on Linux bash too, but there it is much narrower.

**Fix.** The test waits for the next prompt (`PS1='READY> '`) before it
resizes. Readline prepares the terminal before it draws the prompt, so the
race window has closed by then. Production is unchanged. Every terminal
emulator running a readline shell shares this window, and the next resize
corrects the size.

**Rule.** Resize a PTY in a test only when the shell is idle at its prompt.
When a probe repeats a command, give each run its own output marker, so a
repeated write cannot pass for a stale result.
