# 798 — Qualify PTY and case-only operations on the actual volume

The Unix implementation being compiled on Linux does not establish macOS
runtime behavior. The platform Rust job must execute the PTY lifecycle and
case-sensitive or case-insensitive filesystem contracts before either gate
can close.

`terminal::tests::pty_round_trips_input_resizes_and_reaps_the_shell` uses the
production shell spawn, write and resize paths. The shell evaluates a marker,
reports its initial and changed PTY size, and exits with a known status. The
test checks that the child was reaped and the terminal registry released it.
The command handlers share the same blocking helpers as the test; no mock PTY
or transcribed command implementation is involved.

`test_support/case_only_rename.rs` probes the temporary volume's actual case
behavior. Its rename, move and ordered-session tests check object identity,
contents and conflict outcomes. Native-directory and recovery-admission
contracts reuse the probe. An operating system name alone is insufficient:
APFS and NTFS can also be configured case-sensitive. Each contract writes the
observed case behavior to the runner log so a passing case-sensitive run
cannot be presented as evidence for a case-insensitive volume.

Local Linux checks exercise the case-sensitive branch and PTY lifecycle.
macOS/APFS and Windows/NTFS acceptance requires the corresponding runner's
executed tests and recorded case behavior. These tests do not qualify native
macOS UI automation or startup presentation timing.
