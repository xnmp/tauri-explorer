# Ninth AI-operation review

Branch `feat/ai-ops-auto-settle`. User prohibits commits. Contract remains
`docs/lessons/ai-ops-auto-settle-review.md`. All changes are uncommitted.

## Production changes and provenance

1. Branch-introduced: recorded empty streams are reconstructible. Each stream
   validates against its own length/hash. Verified sibling bytes protect reserved
   spools, Unknown settlement, recovery discovery and image-loss notices even when
   the full reply cannot be advertised. Output file barriers now precede the next
   stream's write.
2. The Unix drain cutoff and unread-byte loss existed on origin/dev, which returned
   an error. This branch introduced silent successful truncated/empty replies in
   both Unix and fallback paths. Shared `process_ext/pipe_capture.rs` drains a
   finite queued-byte snapshot after exit, independent of scheduling, and joins
   output workers. Unix uses nonblocking reads/FIONREAD; Windows uses PeekNamedPipe.
3. Branch-introduced: compatible retention includes admission=NULL preparations
   and live jobs registered before capture. Lifecycle grants authorize replacement
   adoption of preparation/job ownership while preserving original IDs/descriptors.
   Job controls reload durable authority after adoption. Incomplete input capture
   retries only the original spec after all old input IO leases have ended.
   Dead-consumer cleanup shares the lifecycle action lane; startup preserves live
   incomplete preparations until upgrade-journal reconciliation. The disconnected
   capture callback delegates cleanup to that same death actor.
4. Branch-introduced: incompatible replacement releases package-owned unretained
   spools even with no admissions. Mixed-contract upgrades preserve only compatible
   admitted custody. SDK2 release also resolves and mutates durable spool storage.

## Fail-first evidence

- `/tmp/hops-ninth-spools-red-direct.log`: 31 passed, 2 failed. Missing recorded
  empty stderr and damaged/missing nonempty sibling collected verified original.
- `/tmp/hops-ninth-process-red.log`: 23 passed, 2 failed. Both descheduled queued-PNG
  readers returned empty capture.
- `/tmp/hops-ninth-retention-failfirst.log`: 0 passed, 2 failed. Accepting captured
  preparation cancelled; incompatible SDK2 replacement retained admission-free spool.
- `/tmp/hops-ninth-sibling-settlement-red.log`: 0 passed, 1 failed. Actual valid PNG
  disappeared during Unknown settlement when nonempty stderr was missing.
- `/tmp/hops-ninth-preflight-red-isolated.log`: 0 passed, 1 failed. Actual concurrent
  recover_owned collected captured inputs before upgrade preflight could retain them.
- `/tmp/hops-ninth-journal-prep-red-isolated.log`: 0 passed, 1 failed. Store.open
  collected unfinished capture before published upgrade journal recovered its grant.

Stale preparation job authority and interrupted capture retry have regression
coverage; they were discovered in code review and were not independently run red
before their first changes. Keep that distinction from observed counterexamples.

## Model and independent review

The actor pauses inside production reply persistence at intent, file creation,
partial/full stdout/stderr/witness writes and barriers, plus temporary manifest
creation/write/flush/rename/publication barriers. Twenty-eight actor phases and
29 crash states replace the formerly atomic reply transition. Presentation,
capture and service dispatch are independent transitions in production order.
Admission-free custody-less spools now have separate byte/quota/lifecycle oracles.
Deep coverage requires 110 families with at least three actual hits each.

Native-work invocation counters distinguish initial/recovery contexts and explicit
paid-generation/local-reconstruction recipes independently of service .start.
Consumer runs and delivery effects are counted separately, with fresh output paths.
Recovery reuses a retained acquisition receipt validated by Store.verify_acquisition;
file existence is not a deduplication proof. Negative oracle tests inject paid
recovery work or discard that proof and require the meters to detect duplicate work.

TestFs separates content durability from directory-entry durability, including
creations, partial writes, rename and unlink; five behavior tests verify rollback.
Random traces start empty deterministically. The retained regression seed
`1cd3c5b...` exposed a fixture-owned custody-less writer permit surviving disable;
quiescence now retires that permit before asserting physical collection. The early
Register→Upgrade→Capture and duplicate acquisition failures also exposed fixture
ordering/protocol omissions, not newly proved production failures.

Independent reviewer confirmed the fixes and tested 65,537 queued bytes with EOF,
a detached writer and overflow (3 passed). Complete-contract model coverage is
not claimed: native scheduling and LiveAutomatic budgets require separate tests;
artifact publication still has atomic boundaries. Host-spool filesystem boundaries
are modeled. Windows/macOS production process modules compile independently, but
neither OS was executed natively in this Linux session.

## Final verification

Final source full library runs, default parallelism:

```text
test result: FAILED. 2265 passed; 1 failed; 79 ignored; 0 measured; 0 filtered out; finished in 65.61s
test result: FAILED. 2265 passed; 1 failed; 79 ignored; 0 measured; 0 filtered out; finished in 63.45s
```

Both failed only the known unrelated creation_is_lazy test. Logs:
`/tmp/hops-ninth-lib-adoption-1.log`, `/tmp/hops-ninth-lib-adoption-2.log`.
An initial run also had the known terminal output timeout (isolated retry passed
1/1 in 0.03s) and the new empty-stderr regression asserting compacted charge
before host-spool sweep. The test now invokes that production sweep first;
no ledger logic was changed to satisfy the assertion.

Native isolated: `Native isolated recovery: 22 passed; 0 failed`;
`Private native environments: 22/22 app and fixture provider verified`.
Detailed result lines: `/tmp/hops-ninth-native.log`; environment proof:
`/tmp/hops-ninth-native-verification.log`. All run via private Xvfb/Openbox,
isolated D-Bus and XDG profiles, never the active desktop.

Exact process-module lib filter: `37 passed; 0 failed; 16 ignored` (6.21s).
Standalone exact-module tests: `8 passed; 0 failed` (0.11s).
Real subprocess suite: `29 process-supervisor outcome fixtures passed`.
Logs `/tmp/hops-ninth-process-{lib-green,fixture-green,native}.log`.
Windows MSVC and macOS ARM64 exact process module cargo checks passed; these
are compile checks, not native runtime qualification.

Affected Vitest: `Test Files 8 passed (8)`; `Tests 118 passed (118)`;
`Duration 2.91s`. `/tmp/hops-ninth-vitest.log`.
Code-map coverage 728/728 tracked source files, no unresolvable references;
the new untracked pipe_capture source is explicitly indexed as well.
`git diff --check` passed. HEAD is unchanged at 5b230813c7bd8ff73563c4619f40263716d29ec6.

Later deep runs found two additional fixture defects (retained seeds):
`1f8b53d0...` starts a new initial paid actor after execution was fenced and its
original provider incarnation restarted; `c7a72f9b...` skips preparation adoption
when repeated compatible upgrade keeps the digest but changes incarnation.
Initial paid actor eligibility now requires original current generation and an
unfenced execution. Recovery recipes remain explicitly unpaid; deliberately paid
recovery remains independently metered/rejected. Preparation callbacks always use
the actual recovery_job seam, including same-digest incarnation changes. Neither
correction modifies production logic or weakens invariants.

The final normal model passed 31 tests, 0 failed, 1 ignored in 17.64s
(`/tmp/hops-ninth-model-adoption-green.log`). Root also ran another full library
pair before this final fixture-only adoption correction; the second reproduced
that same model trace. Those exploratory logs are distinct from the final
full-library pair above, which includes every fixture correction.

Final deep model (`/tmp/hops-ninth-model-deep-adoption.log`):

```text
model required coverage: 110 transitions >= 3 hits; ack-crash=3
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 2344 filtered out; finished in 389.18s
```

Independent coverage parsing confirmed required=unique=110, minimum=3, missing=[],
ack-crash=3. All 1,024 randomized cases and the directed campaign passed.

The final full-library pair includes the last fixture-only correction and is
complete. No implementation, model or verification work remains. No commits were
created.
