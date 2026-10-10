# SDK3 Unix CLI supervision evidence

`src-tauri/src/process_supervisor.rs` provides `early_mode() -> Option<i32>` and `output_controlled(&mut Command, cancelled, (stdout_limit, stderr_limit), cancel_message) -> Result<Output, AppError>`. The coordinator wires early mode before Tauri/logging initialization and uses the output helper only for SDK3 native `host.process.run`. Configure the original command's stdin before calling; arguments, environment, cwd and input stay on that command. Windows retains its existing suspended-start, kill-on-close Job object path.

## Ownership design

The host launches its own executable as an inert process-group anchor. Its only IPC is an inherited unnamed AF_UNIX socket pair. A fixed 40-byte random-nonce handshake has a two-second deadline. The private mode checks its own group identity and connected socket type; Linux also checks the peer PID and UID against its actual parent. Invalid invocation does not launch a leaf or initialize the application.

The original CLI is a separate host child in the anchor's Unix session/process group. Original stdout/stderr pipes and exit status remain host-owned. No CLI argument, environment, prompt or credential is sent to the anchor or written to a spool. Both private descriptors have CLOEXEC; only the anchor endpoint is explicitly inherited by the anchor. The CLI's temporary pre-exec inheritance closes at exec.

The anchor kills its own group on peer EOF/error. It also checks reparenting every 50ms, covering a child held before exec that temporarily retains a CLOEXEC peer descriptor. Command's group setup precedes its final pre-exec parent check, which rejects execution if its original parent has died. Thus a late child cannot execute after group retirement while a zombie anchor still pins the PGID.

On completion, cancellation, overflow, handshake failure and spawn failure, cleanup signals the anchored group before reaping its anchor. WNOWAIT observes the leaf without releasing its PID; successful output returns the leaf's original status. Nonblocking bounded pipe readers are joined on every path. Leaf exit immediately retires descendants holding pipes; output already written by the leaf is still drained. Output bounds are at most 64MiB per stream.

This is native process-group supervision, not an OS sandbox against a program deliberately calling setsid/setpgid to escape ownership or changing UID. Kernel-uninterruptible IO has the usual SIGKILL scheduling limitation. macOS uses the same POSIX interfaces but has not been natively executed in this Linux session; Windows is unchanged and not newly qualified by these fixtures.

## Primary references

- [POSIX process-group membership and inheritance](https://man7.org/linux/man-pages/man2/setpgid.2.html): same-session children may join an existing group; fork/exec preserve membership.
- [Rust CommandExt](https://doc.rust-lang.org/std/os/unix/process/trait.CommandExt.html): process_group applies child setpgid; pre_exec runs before exec and must use async-signal-safe operations; CLOEXEC descriptors close at exec.
- [Unnamed socketpair](https://man7.org/linux/man-pages/man2/socketpair.2.html) and [Unix peer credentials](https://man7.org/linux/man-pages/man7/unix.7.html): private connected descriptors and Linux peer identity.
- [Group signalling](https://man7.org/linux/man-pages/man2/kill.2.html) and [WNOWAIT/reparenting](https://man7.org/linux/man-pages/man2/waitpid.2.html): signal the owned group before releasing its anchor identity; parent death adopts children to init/subreaper.

## Actual Linux fixture results

The standalone fixture compiles this exact production module with a small IO-error shim, never initializes Tauri, and runs only its own fake CLI. Its runner uses an isolated test-only Linux subreaper to collect its terminated descendants. Production supervision does not change global subreaper policy.

```sh
CARGO_TARGET_DIR=/home/chong/Repos/tauri-explorer/src-tauri/target cargo build --offline --locked --manifest-path src-tauri/test_support/process_supervisor_fixture/Cargo.toml
python3 src-tauri/test_support/process_supervisor.py /home/chong/Repos/tauri-explorer/src-tauri/target/debug/te-process-supervisor-fixture
```

14 outcome fixtures passed on 2026-10-10:

- Exact stdout/stderr and exit0, exact nonzero exit23, output exactly at its bound, and successful reuse of the same Command.
- Early leaf exit0 with children/grandchildren retaining both pipes: output preserved and all owned processes stopped.
- Cancellation, stdout overflow and stderr overflow: error returned and all descendants stopped.
- Missing executable: no leaf dispatch, anchor cleanup completes.
- Actual parent SIGKILL: anchor, leaf, child and grandchild all stopped without Rust Drop.
- Actual parent SIGKILL while a leaf is gated before exec: anchor and gated child stopped.
- Private mode rejects a missing descriptor, a regular-file descriptor and an invalid socket handshake without output/application startup.

Logs: `/tmp/te-process-supervisor-build.log`, `/tmp/te-process-supervisor-tests.log`. This module/fixture evidence precedes the coordinator's production broker integration acceptance; it does not qualify paid CLI execution.
