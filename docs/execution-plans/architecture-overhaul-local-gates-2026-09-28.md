# Architecture overhaul: local integration gates, 2026-09-28

This is a **local rehearsal**, not W8.1 acceptance on published `dev`. The
integration checkout is `47830d4e08db1c584f5b80076fd7f0956be4d8de`.
Its parent `a4f8cf32550b71c8b6e3b5059e6ed091d0f19ac1` is the product
source used to build both Tauri binaries and run the browser, Rust, unit, and
bundle checks. The later commit changes only two `e2e-tauri/specs/` assertions;
`git diff a4f8cf32..47830d4e -- src src-tauri` is empty. Read-only
`git ls-remote origin refs/heads/dev` still returned `e8050938` at
13:51 AEST. No branch was pushed or merged for this local rehearsal.

| Gate | Local result | Retained ignored log under `test-results/` |
| --- | --- | --- |
| Type, map, unit and perf | Svelte 0 errors/0 warnings; map coverage 514/514; 2,694 unit passed/3 skipped; 29 perf passed | `check-47830d4e-20260928.log`, `maps-47830d4e-20260928.log`, `unit-a4f8cf32-20260928.log` |
| Rust default and opt-in | Each 1,431 library passed/35 ignored; strict all-target Clippy with `avif,durable-copy-recovery,durable-move-recovery,e2e-renderer-recovery` passed with `-D warnings` | `rust-default-unsandboxed-a4f8cf32-20260928.log`, `rust-features-a4f8cf32-20260928.log`, `clippy-a4f8cf32-20260928.log` |
| Bundle | Main gzip 91,041 B versus 239,791 B budget | `bundle-a4f8cf32-20260928.log` |
| Default native binary | Exit 0: **98 executed passed, 17 feature-gated skipped**, 44/44 spec files in 4m57s | `native-default-final-a4f8cf32-20260928.log` |
| Opt-in native recovery | Exit 0: 7 executed file-recovery cases; 12 executed history/move cases (4+3+3+2); renderer-recovery harness status `passed` | `native-gated-recovery-a4f8cf32-20260928.log`, `native-gated-history-final-a4f8cf32-20260928.log`, `native-renderer-recovery-a4f8cf32-20260928.log` |
| All-view browser | Exit 0: **2,372 passed, 36 skipped, 2,408 total** across Chromium and WebKit in 45.2 minutes, with host libsoup 3.6.6 preloaded | `all-views-report-focus-fix-20260928.log` |
| High load | Exit 0: 7/7 passed, including the 256 MiB heap-cap case | `load-a4f8cf32-20260928.log` |

The default Tauri binary SHA-256 was
`d188f7e4912b60860157330e32ac3e30bed5554b6452cbc06583bd981b4a22d7`.
The separate opt-in gated binary SHA-256 was
`fb57f4b2fb778a1ecd62751b24c631b02b414901613c955ac40ed70aa84b18d7`.
The passing default-native, gated-recovery, gated-history, renderer-recovery,
all-view browser and load logs have respective SHA-256 values:

```text
0212ed056f8a4498bf7346864df5f3ac402411f28c83a567380732bd93093599
36cafcfba881b31e9dc9fe23d97630585019a18062b15116e29a6320f4fc2f13
dd7e96bc970472ae9e678abb2417b2a8ed487725819b3caa72f6e238409330c9
b5cdb49efb37bf0a78f5970827291db259107e7c7b68912228dcaddba53fa214
43355564793f64061445d3aff77fe2ee227a921ee6e6d4b239149aa2d8e0166d
1ca9596f9f63ae0f33605dae6d3999ff10ff0b737539f97056a4f2a76dc46155
```

The exact final-head Svelte and map rechecks are in
`check-47830d4e-20260928.log` (SHA-256
`1ef046a0aba58a17e56e088eaf041eae627a2442a6ab4a9e7a4754e849e9d8d1`)
and `maps-47830d4e-20260928.log` (SHA-256
`70b508a5185d4809b635d8202984bc6001f54238dd42e5a47135a2da0deb7943`).
The Clippy invocation recorded in the operator notes was
`cargo clippy --offline --all-targets --features avif,durable-copy-recovery,durable-move-recovery,e2e-renderer-recovery -- -D warnings`;
the retained compiler log confirms exit 0 but does not itself print those
arguments.

The all-view pass used a local host-library workaround: Playwright's bundled
WebKit network process mapped libsoup 3.6.5 during earlier failing bootstraps,
while the passing run was invoked with
`LD_PRELOAD=/usr/lib/libsoup-3.0.so.0`, the host's libsoup 3.6.6. This
invocation is recorded in operator notes, not the Playwright result log. A
host core-dump check found 16 `WPEWebProcess` crashes in the passing run's
time window: `wpe-page-cores-20260928.log`, SHA-256
`11993f3df0f7768993894d830f5ed33e9e04678985cdfe6792587c56edb7a381`.
They do not negate the 2,372 passing assertions, but they rule out claiming crash-free
WebKit stability. The full Playwright log alone cannot assign those cores to
specific cases. A [read-only core triage](architecture-overhaul-webkit-core-triage-2026-09-28.md)
groups their native WPE/graphics stacks; a 200-page blank WebKit control
completed without a new core, which does not isolate the app-suite trigger.
The high-load Vite server reported that its worktree-linked
Inter font file was outside the serving allow list; the seven load assertions
passed under that local font-loading limit.

The [report-dialog screenshot](../../screenshots/fix/report-dialog-focus/report-draft-preserved.png)
was visually checked: Title and Description retain separate input values while
an invalid-image warning is displayed. It accompanies the local WebKit focus
fix; a matching GitHub issue and PR remain unpublished.

The first native smoke run used the opt-in durable-move binary against
default-build expectations and failed four spec files. Re-running on the
correct default build resolved the policy mismatches. The remaining native
test assertions were corrected to compare only the intended target-window
fields and the status of the specific recovery record. The full default suite
and the CI-ordered four-file gated sequence passed after those repairs. The
initial sandboxed Rust run had permission/mount failures; the same suite
passed with normal local socket and mount access and no Rust source change.

W8.1 still needs these gates on one final, published `dev` commit. W2.4 needs
three more qualifying consecutive Windows `dev` smoke executions after #830
merges. The W4.5 NTFS alias and W5.3 Mac2 pilots have passed but await their
PR reviews and `dev` merges; W6.1 and W6.2 also await integration. W8.2 needs
its final-tip audit. Physical-Mac startup W5.4 remains a follow-up outside
this release count.

## Combined integration refresh, 2026-09-28 21:46 AEST

The later detached integration head `5ff25971dd72350b05e477892baea6d67efa130a`
combines pending overhaul changes and the reviewed #831 diagnostic delta. It
is **not** published `dev`, which remained `e8050938` at the preceding remote
check. No local native GUI test ran in this refresh.

| Gate | Result on `5ff25971` |
| --- | --- |
| Svelte and native E2E TypeScript | `bun run check`: 0 errors, 0 warnings; `bun run check:e2e:tauri`: exit 0 |
| Unit and perf | `bun run test`: 2,699 passed, 3 skipped across 293 unit files; 29/29 performance contracts |
| Code maps | `python3 docs/code-map/validate.py --coverage`: 514/514 source files, 0 unresolvable refs |
| Rust default library | `cargo test --lib --offline`: 1,431 passed, 35 ignored, 0 failed |
| Rust opt-in library | `cargo test --lib --offline --features avif,durable-copy-recovery,durable-move-recovery`: 1,431 passed, 35 ignored, 0 failed |
| Strict Clippy | `cargo clippy --offline --all-targets --features avif,durable-copy-recovery,durable-move-recovery,e2e-renderer-recovery -- -D warnings`: exit 0 |
| Bundle | Main gzip 91,041 B versus 239,791 B budget; startup graph passed |

The first default Rust attempt used this worktree's uncached `src-tauri/target`
on an almost-full workspace filesystem and failed **during compilation** with
`No space left on device`; no library test ran. `cargo clean` removed that
attempt's newly created 3.2 GiB build target. Both successful library runs and
Clippy then used the existing `/tmp/overhaul-rust-a4f8` Cargo cache, with
normal local socket/mount access and no Rust source change. Their retained
ignored logs under `test-results/` are:

```text
rust-default-integration-5ff25971-20260928.log   3d53d63345e9dba884adb77c0ce31a1da5ed7219c26071d73ea5c445ec92ddbe
rust-features-integration-5ff25971-20260928.log  4eafa5f99323c18db358d865362e511d900d7c36ba971bacdff0d99459466dbe
clippy-integration-5ff25971-20260928.log          3be4714a10ff7a2610d9b85e29ec1b78263c41d6b2eefb7b3765e2152304be51
```

The TypeScript, map, unit, perf and bundle results were read from the completed
command output; separate persistent logs for those refreshed commands were not
saved. This refresh catches integration failures in the combined source but
does not satisfy W8.1 until all gates run against the final published `dev`
commit, including native and all-view browser outcomes.
