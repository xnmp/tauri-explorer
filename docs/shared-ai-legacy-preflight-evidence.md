# Genuine SDK2 Trace private preflight evidence

The Linux fixture builds the exact Trace source at
`cae90fb4344375cf8fc1453df74f50ecdc0b4d55` (plugin 0.2.3, SDK2). Its Cargo
package, library identity, dependencies and frozen lock remain unchanged. The
only manifest changes disable automatic binary discovery and name the original
main source `te-legacy-sdk2-preflight-fixture`, so the current Trace executable
is not overwritten. It reuses the existing Trace Cargo cache.

```sh
python3 src-tauri/test_support/legacy_trace_preflight.py \
  --trace-checkout /home/chong/Repos/TraceExplorer/.worktrees/shared-ai-services \
  --target-dir /home/chong/Repos/TraceExplorer/.worktrees/shared-ai-services/src-tauri/target \
  --evidence /tmp/te-legacy-sdk2-preflight-evidence-2
```

Observed **4/4 passing native outcomes** in
`/tmp/te-legacy-sdk2-preflight-2.log`:

- Schema8 ledger with real WAL/shared-memory companions and absolute references
  to unfinished publication, terminal anchors, pending save and pending discard
  evidence: original file bytes, modes and identities remain unchanged.
- Schema7 copy migrates to8; original ledger/companions and referenced files
  remain unchanged. Original unfinished runs and save evidence stay unsettled in
  the validation copy.
- Missing original database remains absent while the private copy directory
  receives a schema/owner lock.
- Malformed copied database is rejected without modifying its original.

Each real backend receives only `initialize(deferRecovery:true)` and a rejected
ordinary query where initialization succeeds. It returns `ready:false`; no
activation is sent. No reverse host request or user event is observed. Its
validation owner lock is held during initialization and released after actual
process exit. Database/sidecar copies have independent inodes. All data,
referenced outputs and staging anchors live under disposable fixture roots;
provider authentication environment variables are removed from the child only.
There are no provider calls, keys, user-profile reads or installations.

Retained evidence in `/tmp/te-legacy-sdk2-preflight-evidence-2` contains the exact
source archive, source file hashes, original/altered manifest hashes, unchanged
Cargo lock hash, build command/toolchain, binary digest, replies and outcome
snapshots. The executable remains in the existing cache rather than duplicating
a debug binary. Its measured SHA256 is
`5a374af8fa6a1f27afb45db45af62116ed5d5695f25bb85bcc8a8e7fce537bab`.
The source archive SHA256 is
`20007e0cb5410e74848d22acc4fcaa9e904d15719a3de02b370f5351240f5776`.
The current Trace executable's digest was identical before and after the build.
The first attempt built successfully but exceeded disk quota while duplicating
the debug executable; that failure remains in
`/tmp/te-legacy-sdk2-preflight.log`. Only that attempt's partial owned executable
copy was removed.

This qualifies the inspected legacy initializer on Linux. It does not exercise
current host admission fences, reverse quarantine, shutdown or lifecycle
orchestration. It does not establish behavior for arbitrary SDK1/2 binaries,
which are native programs with the user's OS privileges. A copied ledger still
contains absolute publication paths: activation/recovery can act on those
paths, so the validation process must be stopped and joined without activation.
Committed activation requires a fresh backend using the real data directory.
