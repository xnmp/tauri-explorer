# W6.1 standalone extraction preflight — 2026-09-28

The standalone #817 extraction is source commit
`c4696e8e0016bcd547358d49bb6b6a3d52118aeb`, based on published
`dev` `e8050938d3e602eed4700fe005b04dcc0f524a47`. It excludes the
unmerged #812/#816 fixture changes. The patched Wry GTK IPC callback is the
same as in the earlier combined-source four-hour run, but that run's source
`75859d97` included #812/#816. Its report cannot qualify the standalone
extraction or final `dev`.

The clean-worktree `bun run build:native:qualification` build of `c4696e8e`
recorded binary SHA-256
`3dd64cfce6fb8ff749243a0eb4bcba6a7c5a188b1c8c1d7fc9639e4aef5b6a1c`.
The [committed bounded report](../../../qualification-results/linux-extracted-c4696e8e-dual-private-edd11a8752e5.json)
records two complete native cycles: **8/8 scenario outcomes passed**, with
`window-workspace` warm in cycle 1 and fresh in cycle 2, no run errors or
failure artifacts, and display scale 1. The run used a private Xvfb/Openbox
display `:102` and isolated XDG config/data/cache/state directories. During
the run, the app and WebKitWebDriver processes were observed with
`DISPLAY=:102`; that live environment snapshot was not retained as an artifact.
No native test window was shown on the user's desktop.

The report SHA-256 is
`91ed9fa67495f586b8b3b9f1e3860615936463b3bc6a0fe2a67a52f4d9308282`.
The local build and native-run logs under `/tmp/` were retained for this
session with SHA-256 values
`24a3a578f6ba3583864395546514c99239af73cd7a53915b41b0278bf5cacbeb`
and `4f5668aee9e560cd2c12d9c0ac842042eaa63937cb30e5e152c129ecad399d6c`;
they are not committed PR artifacts.

On the extracted source, Svelte check and native TypeScript passed, 40 focused
Vitest contracts passed, map coverage was 514/514, Rust library tests passed
1,427 with 35 ignored under normal local socket/mount access, and strict
all-target feature-gated Clippy passed. The first sandboxed Rust run had four
socket/mount permission failures and one parallel thumbnail assertion; the
same suite passed with normal test permissions without a source change.

This two-cycle preflight verifies both window paths and all four scenarios on
the extracted source. It is not a four-hour retention result. Final W6.1
integration and W8.1 acceptance require the reviewed change on `dev` and the
final-tip gate set.
