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

Actual Wry/production-broker fixture:
`src-tauri/src/installed_plugins/backend_native_tests.rs`. The first private run
passed in `/tmp/te-lifecycle-real-broker-native.log`; the reviewed run with a
retained native publisher passed in `/tmp/te-lifecycle-real-broker-reviewed.log`.
It observes an old index and unchanged real DB during held validation, responsive
unrelated RPC, all reverse requests denied, rollback preserving DB/index, fresh
real-data startup, actual reader/writer/stderr retirement, prompt held-candidate
termination and shutdown waiting for the publisher. It uses private fake SDK2
processes and no real provider or credential operations. The final source also
asserts zero native candidate events and rejection of late mutation admission;
this final fixture passed in `/tmp/te-lifecycle-real-broker-final.log`.

```sh
cd /tmp/te-shared-ai-host
fixture_root=$(mktemp -d /tmp/te-lifecycle-native.XXXXXX)
mkdir -p "$fixture_root/config" "$fixture_root/data" "$fixture_root/cache" "$fixture_root/state" "$fixture_root/runtime"
chmod 700 "$fixture_root/runtime"
export XDG_CONFIG_HOME="$fixture_root/config" XDG_DATA_HOME="$fixture_root/data" XDG_CACHE_HOME="$fixture_root/cache" XDG_STATE_HOME="$fixture_root/state" XDG_RUNTIME_DIR="$fixture_root/runtime"
export TE_LIFECYCLE_NATIVE_FIXTURE=1
export CARGO_TARGET_DIR=/home/chong/Repos/tauri-explorer/src-tauri/target
env -u WAYLAND_DISPLAY -u OPENAI_API_KEY -u CODEX_API_KEY -u CODEX_ACCESS_TOKEN -u ANTHROPIC_API_KEY GDK_BACKEND=x11 xvfb-run -a dbus-run-session -- cargo test --locked --offline --manifest-path src-tauri/Cargo.toml --lib installed_plugins::backend::native_tests::native_private_preflight_retirement_and_shutdown -- --ignored --exact --nocapture --test-threads=1
```

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
