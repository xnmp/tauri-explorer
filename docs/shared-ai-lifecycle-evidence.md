# Shared AI private lifecycle checkpoint

This document records the 2026-10-10 continuation after
`docs/handovers/2026-10-10-061310Z-issue-1047.md`. It supersedes that handover's
unimplemented lifecycle proposal; it does not qualify the entire implementation
for merge. Windows integration/native verification remains required.

## Ownership and transitions

Package mutation fencing lives in native admissions, independently of Broker
existence or SDK. Call/startup admission and fencing share a mutex. A startup
lease is acquired before the per-package handshake lock and retained through
activation. Ordinary routes cannot cross a fence; unrelated packages continue.

Retirement extracts brokers before killing/reaping/joining their actual IO
workers. Quiesce, snapshots, candidate handshakes and rollback run without the
global lifecycle/registry/provenance gates. Publisher admissions survive through
run-handle registration, then their evidence leases survive publication.

Preflight uses the explicit prepared payload and deep copies of declared state,
including SQLite companions and initial data, under a private validation root.
It never registers that root with the host ledger, copies initial data into the
real root, schedules migration or enters the routable broker map. Every SDK's
candidate reverse request returns `preflight_not_active`; candidate notifications
are quarantined. Validation ends by stopping and joining the candidate. Real
activation creates a separate backend against the real root after commit.

The journal now supports Prepared → Committed → Published. The Committed decision
contains the bounded validated planned index and precedes index publication.
Recovery completes publication if interrupted. Published prevents a leftover
snapshot from undoing a subsequent disable/remove. Every package mutation settles
an earlier journal first. Failed/uncertain commit or failed restoration retains
admission fencing; successful recovery releases only the retained fence after
checking actual native ownership. Normal guard Drop performs no RPC.

Journal/index decoding rejects bad digests, duplicate package IDs, duplicate
restore targets and changes to unrelated packages before effects. Index writes
are capped at1MiB; journals at4MiB for both old and planned metadata. Encoded-size
checks precede persistence. Existing legacy journals without committedIndex remain
readable.

Shutdown first closes admission and drains routable/private process ownership.
It waits for queue and mutation settlement, every admitted worker's actual return,
and native publisher leases before releasing the Linux profile owner. Late
lifecycle reads/mutations and admission acquirers reject closing. Runtime startup
is enabled only after ledger/journal/job reconstruction succeeds.

Reverse text also owns package admission. Its cancellation predicate retains an
Arc lease into native configuration/credential workers, so an early timeout reply
does not let snapshots overlap their actual IO. Old consumers cannot activate or
commit over retained shared-operation history, including an explicitly stopped
unknown outcome; compatible provider changes remain allowed. The compatibility
query uses exact SQL existence rather than the bounded presentation snapshot.

## Evidence and reproduction

Focused installed-plugin regressions: **68 passed, 2 ignored** in
`/tmp/te-lifecycle-journal-budget-tests.log`. Prior reviewed and legacy-retention
checkpoints passed67 cases. The ignored cases are a profile
ownership child helper and the explicitly executed native fixture. These runs
cover fence/startup/text ownership, forward recovery, leftover Published snapshots,
malformed journals, service routing, Stop and downgrade retention. The final run includes the valid dual-index journal exceeding1MiB recovery case.

Actual Wry/production-broker fixtures, each `#[ignore]` and executed in its own
`cargo test` process with its own private `/tmp/te-lifecycle-native.XXXXXX`
profile (the CI step "Verify actual broker private preflight and shutdown" runs
both). They use private fake processes and no real provider or credential
operations.

1. `native_private_preflight_retirement_and_shutdown`
   (`src-tauri/src/installed_plugins/backend_native_tests.rs`). It observes an old
   index and unchanged real DB during held validation, responsive unrelated RPC,
   all reverse requests denied, zero candidate events, rollback preserving
   DB/index, fresh real-data startup, actual reader/writer/stderr retirement,
   prompt held-candidate termination and rejection of late mutation admission.
   Publisher proof: shutdown also joins the job reconciler, which observes
   closing only between 2 s sleeps (`job_bridge.rs`), so the former 100 ms
   "still pending" check could not tell a publisher wait from a poller wait. The
   fixture now holds the native publisher lease until 5 s (2 × poll interval +
   1 s) after shutdown began, asserts shutdown has not returned and the profile
   lease is still owned, then drops the publisher and requires return within
   500 ms; observed 45 µs–1.5 ms. Mutation check: with
   `provenance::wait_for_publishers()` commented out of `shutdown`, the fixture
   fails ("Shutdown finished while an admitted publisher lease was live",
   finished in 2.24 s, i.e. at the poller bound); restored source passes.
2. `native_startup_recovery_holds_readiness_and_shutdown_for_actual_io`
   (`src-tauri/src/installed_plugins/backend_native_recovery_tests.rs`). Before
   `initialize`, public `Store` APIs seed the private `service-state` ledger with
   an accepted shared-provider claim owned by dead incarnations of two fake SDK3
   packages and its running presentation job. The provider records every method,
   answers `cancel` with an in-flight receipt and holds `status` on a gate file;
   the consumer holds each `jobs.status` on its own gate.
   - Readiness observables: startup marks the job `recovering` before any
     consumer receipt; while the recovery actor is inside the provider `status`
     RPC the claim stays `accepted` without attention, `mutation_allowed` refuses
     both packages and `ai_operations::snapshot()` lists the operation; the job
     stays `recovering` until the held `jobs.status` returns, and only that
     returned receipt moves it to `running`.
   - Shutdown: `backend::shutdown` stops both brokers, which returns their
     pending RPCs (both processes are reaped). The recovery actor then writes its
     attention evidence; the fixture holds the ledger write lock so that durable
     IO stays in progress. Shutdown has not returned and still owns the profile
     lease 2.5 s after it began (past the 2 s poller bound, inside the ledger's
     3 s busy timeout); after the lock is released it returns within 32–48 ms
     and the attention write is already durable, with the claim still retained
     (`accepted`) for the next start. Mutation check: with
     `service_bridge::shutdown_recovery()` commented out, the fixture fails
     ("Shutdown returned while the recovery actor was inside ledger IO").
   - Unpaid recovery: the provider received only `initialize`,
     `lifecycle.activate`, `services.fixture-image.v1.cancel` and
     `services.fixture-image.v1.status`; the consumer only `initialize`,
     `lifecycle.activate` and `jobs.status`. No `*start` method was issued.

Results on 2026-10-10 (HEAD `6126913e` plus these test changes), logs in
`/var/tmp/te-native/`: the unchanged fixture 1 passed on the original source
(`baseline.log`, 1 passed, 2.16 s). After the changes, fixture 1 passed 6/6
(`strengthened.log`, `final-pub-{1,2,3}.log`, `workflow-lifecycle.log`,
`committed-pub.log`; 5.66–5.84 s each) and fixture 2 passed 6/6 (`recovery.log`,
`final-rec-{1,2,3}.log`, `workflow-lifecycle-recovery.log`, `committed-rec.log`;
4.69–4.87 s each). The `workflow-*` pair ran through the CI step script itself;
the `committed-*` pair ran on the committed (formatted) source.
`cargo clippy --all-targets -- -D warnings` and `cargo fmt --check` pass. Mutation logs:
`mutation-publishers.log`, `mutation-recovery.log`.

```sh
cd /tmp/te-shared-ai-host
export TE_LIFECYCLE_NATIVE_FIXTURE=1 CARGO_TARGET_DIR=/home/chong/Repos/tauri-explorer/src-tauri/target
for test in \
  installed_plugins::backend::native_tests::native_private_preflight_retirement_and_shutdown \
  installed_plugins::backend::native_recovery_tests::native_startup_recovery_holds_readiness_and_shutdown_for_actual_io
do
  fixture_root=$(mktemp -d /tmp/te-lifecycle-native.XXXXXX)
  mkdir -p "$fixture_root/config" "$fixture_root/data" "$fixture_root/cache" "$fixture_root/state" "$fixture_root/runtime" "$fixture_root/home"
  chmod 700 "$fixture_root/runtime"
  CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}" RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}" HOME="$fixture_root/home" \
  XDG_CONFIG_HOME="$fixture_root/config" XDG_DATA_HOME="$fixture_root/data" XDG_CACHE_HOME="$fixture_root/cache" XDG_STATE_HOME="$fixture_root/state" XDG_RUNTIME_DIR="$fixture_root/runtime" \
    env -u WAYLAND_DISPLAY -u OPENAI_API_KEY -u CODEX_API_KEY -u CODEX_ACCESS_TOKEN -u ANTHROPIC_API_KEY GDK_BACKEND=x11 xvfb-run -a dbus-run-session -- cargo test --locked --manifest-path src-tauri/Cargo.toml --lib "$test" -- --ignored --exact --nocapture --test-threads=1
  rm -rf "$fixture_root"
done
```

Observation (not a defect claim): a clean shutdown that interrupts startup
recovery durably sets `needsAttention` on the still-retained claim
(`recover_generation` marks every remaining claim once closing ends its loop).
The claim stays non-released and is recovered again on the next start.

The genuine previous Trace binary independently passed4 native initialization
cases without activation; see `docs/shared-ai-legacy-preflight-evidence.md` and
its exact committed source, executable and original-file hashes.

The first full host Rust run failed14 filesystem cases amid confirmed tmpfs
quota/disk-IO errors (`/tmp/te-lifecycle-full-host-native.log`:1958 pass/47ignored).
A repeat used a repository-backed private TMPDIR and four workers; it passed1965
cases but failed7 fixtures, including non-repository detection, Unix socket path
length and path-memory assumptions (`/tmp/te-lifecycle-full-host-native-repository-temp.log`).
A third repeat uses a short private `/var/tmp/teai.XXXX` directory outside Git;
its log is `/tmp/te-lifecycle-full-host-native-short-temp.log`. These broad runs
have not yet established a fully passing library suite. The intermediate command was:

```sh
mkdir -p /home/chong/Repos/TraceExplorer/.worktrees/shared-ai-services/src-tauri/target/host-suite-temp
TMPDIR=/home/chong/Repos/TraceExplorer/.worktrees/shared-ai-services/src-tauri/target/host-suite-temp CARGO_TARGET_DIR=/home/chong/Repos/tauri-explorer/src-tauri/target cargo test --locked --offline --manifest-path src-tauri/Cargo.toml --lib -- --test-threads=4
```

Do not substitute a partial checkpoint's tests or this broker fixture for final
packaged native UI, platform filesystem/credential and paired-PR acceptance.
The Windows namespace remains an unwired candidate, with cross-checks but no
native Windows qualification yet. The installed runner now reports its build
command as unknown instead of inventing a command/flags; final packaged evidence
must record the actual build independently.
