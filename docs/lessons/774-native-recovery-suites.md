# 774 — Gated native recovery suites never ran

The recovery acceptance specs (`file-recovery`, `file-forward-history`,
`file-history-lifetime`, `move-retirement`) need a binary built with the opt-in
recovery features plus fixture directories. No workflow supplied either, so
every run skipped them. WDIO counts a skipped spec file as passed, so the
suites reported green while never executing. The first real run found three
stale specs, one harness defect and one product bug.

## A skip must be able to fail

`gatedDescribe` (`e2e-tauri/specs/gated-describe.ts`) skips a suite whose
prerequisites are missing, except when `TAURI_E2E_REQUIRE_GATED=1`. There the
same absence registers a failing test that names the missing prerequisite.
Only the job that exists to run the suite sets the variable. A local run
without fixtures still skips quietly.

## A launch fixture is consumed once

With `TAURI_E2E_FILE_RECOVERY_DIR` set, every launch seeds its recovery record
there, and it refuses to overwrite an existing one. The second launch in a
multi-spec run panicked in setup with `File exists`. Only `file-recovery`
consumes that record, so it runs in its own WDIO invocation and profile.
Nothing else may see the variable.

## A failed session start leaked the driver

WDIO skips `afterSession` when session creation fails, and the driver group is
spawned `detached`. After the panic above, the leaked `tauri-driver` pair kept
4444/4445, and every later spec in the run failed to start. The config now
registers an exit-time reaper (`reapNativeProcessGroupOnExit`) that SIGKILLs a
group the ordinary cleanup never reached. Look for a leaked driver before
debugging a cascade of "session" failures.

## Specs rot silently against later ADRs

- **Automatic retirement (ADR 0023).** Creating a new record retires a
  restored record whose retained publication is still published. The
  overwrite test ran before the channel tests and retired the fixture record
  they inspect. It now runs after them and asserts the retirement.
- **One channel per renderer.** A renderer keeps only its latest recovery
  channel. The probe's raw leases take it from the dialog's own
  subscription, so a test that reads the dialog after them must reload first.
- **Durable moves have no Redo (ADR 0020).** `file-move-recovery` asserts the
  default build's Undo/Redo cycle, so it belongs to the ordinary smoke job,
  not the durable one. It also leaves a deliberately unresolved record that
  fences later moves in a shared profile.

## The product bug: two inverses for one durable move

`performFileTransfer` pushed a path-only Move inverse whenever the receipt had
no `replacement`. A durable single-item move returns `relocation` instead, and
native history had already recorded that record as the inverse. Undo ran the
path-only action first, which lesson 685 warns can relocate the last copy of
the data. Treat any native-owned inverse (`replacement` or `relocation`) as
the history entry. `cross-device-move-history.spec.ts` found it by checking
that Undo leaves neither an Undo nor a Redo in a durable build.
