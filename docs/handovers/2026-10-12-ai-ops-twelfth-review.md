# Twelfth AI-operation review

Branch `feat/ai-ops-auto-settle`, base HEAD `5a1ce2cf`, repository `/var/tmp/te-wt2/hops`.
No commit or merge. The existing stderr-directory-sync proptest regression seed
`be352b742e5523baf59c3b122879b57f5c6b1f90ae22cc095242c4b86966bded`
is preserved.

## Completion protocol and diagnostics

All durable ProcessSpool/native capture paths share
`Store::durable_host_completion`. It fsyncs stdout/stderr and their directory
entries, writes status/hash/length to a temporary completion sidecar, fsyncs it,
atomically renames it to `completed.json`, and fsyncs the spool directory.
The sealed-sidecar rename is the success publication; its directory barrier
makes that publication durable against power loss. SQLite identity/status
updates are derived metadata. Recovery/sweeping reconstructs a missing DB
completion identity from the sealed sidecar before delivery. Existing pending
markers and repeated completed manifests remain compatible metadata paths.

Destructor abandonment now checks for a seal under writer exclusion; it can
release unsealed capture but cannot release a sealed reply. Reserved-spool
sweeping also preserves an unreadable/damaged seal until explicit settlement.
Delivery acknowledgement and explicit removal/settlement retain release
permission. Pre-seal crashes still settle as Unknown, release charge and never
replay paid generation.

The common pipe reader independently bounds diagnostics. Stderr overflow keeps
a prefix, suffix and `[stderr truncated]` marker within its limit and does not
set stdout's overflow signal. Stdout overflow remains execution failure.
Both production executors use this same diagnostics reader.

## Reference contract and additional deep blocker

The model records `sealed_original` from the successful seal event independently
of database metadata. Restart cannot downgrade it or use RAM/unflushed witnesses
to satisfy conservation. The checkpoint-10 crash (seal durable, DB not committed)
now requires the identical delivered original; checkpoint 11 indexes it.
Unsealed checkpoints 5 and 7 retain the Unknown outcome.

Transient consumer IO errors explicitly defer the attempt, retaining
unacknowledged custody. Existing consumer journal and copied output must retry
file/directory synchronization before acquisition. The saved failing trace has
a deterministic regression that asserts a real deferral and eventual delivery,
exact bytes and acknowledgement after faults clear. Quiescence still requires
production recovery convergence, rather than waiving the final outcome.

Independent diagnosis of the eleventh handover's separate deep failure found a
real custody join error: recapture can use a newer consumer incarnation while
its Accepting job still names the old incarnation. Compatible replacement now
joins these by the existing `same_owner` package/digest rule. Model trace and
Store regressions cover retaining this input across incarnations and releasing
input custody for a different digest.

Deep exploration also exposed two driver errors. An unbound reservation after
settlement is independent when it has zero operation custody. The driver now
reads committed custody after real reservation/capacity admission, tracks truly
standalone CLI output independently, fails missing explicit/active binding,
and aborts an unsupported other-operation recipe before child invocation.
Quiescence releases every standalone handle, including overwritten raw slots.
This does not prove production refuses arbitrary cross-admission unbound calls;
that execution is outside this fixture's supported recipes.

The operation-ID allocator also doubled as consumer incarnation. Provider
upgrade thereby fabricated a consumer replacement and expired a retained,
capacity-blocked preparation. Broker identities now live in a per-package map:
registration allocates only operation IDs, lifecycle changes replace only the
affected broker, redundant enable preserves it, and restart replaces all brokers.
Callbacks, idle participants and preparation reconciliation share that identity
lookup. Real restart still refuses an expired unadmitted capture without a
replacement grant; the model accepts only that exact refusal with unchanged
paid-start count and preserved captured inputs, then requires automatic
settlement and cleanup. All generated regression seeds remain saved.

## Fail-first and adversarial evidence

With production fixes reverted, preservation regression failed with
`original bytes disappeared`; native exit-zero/stderr-overflow regression failed
with `Child output exceeded its limit`. The separate compatible-preparation
regression failed with `compatible replacement discarded accepting preparation`
before correcting the join. Logs:

- `/tmp/hops-twelfth-red-seal.log`
- `/tmp/hops-twelfth-red-diagnostics.log`
- `/tmp/hops-twelfth-red-preparation.log`

Independent adversarial review confirmed sealed-sidecar commit ordering,
restart/destructor preservation, diagnostic truncation and stdout overflow
failure. It classified actual arbitrary-consumer filesystem behavior as
PLAUSIBLE, bounded by the model's consumer-journal fixture. Both real production
executors passed exit-zero/excess-stderr probes; these isolated subprocesses
have no GUI or host clipboard interaction. Store crash tests exercise the
first seal's temp creation/write/file sync/rename/directory sync, including
host crash and simulated power loss. Before the directory barrier a host crash
can recover a visible rename, while power loss can remove the uncommitted rename.

## Verification

Final deep model passed 1,024 random cases plus the directed campaign; all
127 required transitions reached at least three hits (`ack-crash=3`).

Requested deep model and complete lib runs use
`CARGO_TARGET_DIR=/var/tmp/te-wt2/target-hops`; lib uses `--test-threads=8`.
Final complete lib repeats run sequentially after deep, with no source edits or
rebuild replacing their executable during subprocess tests.

Final observed result lines:

```text
Deep: test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 2404 filtered out; finished in 286.47s
Lib final 1: test result: FAILED. 2325 passed; 1 failed; 79 ignored; 0 measured; 0 filtered out; finished in 55.67s
Lib final 2: test result: FAILED. 2325 passed; 1 failed; 79 ignored; 0 measured; 0 filtered out; finished in 53.04s
Lib final 3: test result: FAILED. 2325 passed; 1 failed; 79 ignored; 0 measured; 0 filtered out; finished in 58.68s
Targeted model: test result: ok. 51 passed; 0 failed; 1 ignored; 0 measured; 2353 filtered out; finished in 12.06s
Vitest: Test Files 287 passed (287); Tests 2914 passed (2914)
Code-map coverage: 734/734; zero unresolved references
```

All three final lib failures are solely the known
`file_mutation::tests::recovery_admission::creation_is_lazy_and_competing_entry_plans_leave_names_and_bytes_unchanged`.

Earlier complete runs produced 2320/1, 2320/1 and 2317/4 passed/failed. The latter
included three subprocess launch ENOENT errors while another Cargo invocation
rebuilt/replaced their executable; final repeats avoid that interference.
Intermediate deep failures were the saved standalone-custody, provider-only
identity and real stale-restart refusal traces described above. No seeds deleted.

Logs: `/tmp/hops-twelfth-model-deep-final3.log`,
`/tmp/hops-twelfth-model-targeted-final2.log`,
`/tmp/hops-twelfth-lib-final-{1,2,3}.log`, `/tmp/hops-twelfth-vitest.log`,
`/tmp/hops-twelfth-map.log`, `/tmp/hops-twelfth-native-spool.log`,
`/tmp/hops-twelfth-native-supervisor.log`. Native spool regressions passed 2/2; exact production
supervisor and fallback subprocess probes both preserved the original PNG with
bounded prefix/suffix diagnostics. First-seal tests also passed in the full lib
suite. `git diff --check` passed. No macOS/Windows runtime or GUI qualification.


Exact requested commands:

```sh
CARGO_TARGET_DIR=/var/tmp/te-wt2/target-hops cargo test --manifest-path src-tauri/Cargo.toml --lib ai_operations_reference_state_machine_deep -- --ignored --nocapture
CARGO_TARGET_DIR=/var/tmp/te-wt2/target-hops cargo test --manifest-path src-tauri/Cargo.toml --lib -- --test-threads=8
bunx vitest run tests/domain tests/state --maxWorkers=2
```

The complete lib command ran three times on final source after the passing deep
campaign (six complete lib runs total). The saved stderr-sync seed remained
present; no final run saved a new counterexample. Independent adversarial audit
confirmed the final custody attribution, per-package identity, exact stale
preparation refusal, completion preservation and diagnostic overflow separation.
No commit, merge, issue close, deployment, native GUI or physical desktop action.
