# #760: A committed decision must not outlive what it can accomplish

Durable move retirement had several ways to strand a record while removing
nothing. Each fix below has a regression test that failed before the fix.

**Admit what you can later discard.** Cleanup plans have a byte budget, but
forward moves had no matching cap. A long-path tree of about 2,000 entries was
moved successfully and could then never be discarded. Forward moves now run the
same bounded walk and budgets over every payload they would retain before any
record exists. When a limit is enforced at a later phase, apply the same limit
at admission.

**Admission is wherever a retained payload is defined, not just move start.**
Undo parks the live destination as `publication`, and the user may have grown
it deep inside after the move. The top-level version check sees only the top
directory's own mtime. Such a destination was parked, and the restored record
could then never be discarded, forgotten or re-applied. Undo now walks the
destination under the same bounds before any durable effect, returning an
unchanged (not uncertain) error so the history entry survives, and once more
right before parking it.

**A decision that removed nothing should be withdrawable.** `BeginRetirement`
fences history. Re-verifying endpoints after it and refusing consumed Undo for
nothing. Withdraw only on verification refusals, never on checkpoint errors: a
checkpoint error simulates a crash, and crashes resume. Before withdrawing,
prove "untouched" by strict observation (manifest, exact payload version, every
planned entry present), never from the step label. `Removing` does not mean
anything was removed. Keep the effect revision unchanged so the surviving
history entry claims the record again. A refused claim leaves the native history
entry in `remaining`, which is why this works.

**Enforcement must only claim what it can progress.** Claiming advances the
generation and invalidates what the user is inspecting. A reported failure waits
for an explicit retry. An unobservable volume is checked read-only before any
claim, and a Preserved retirement records its reason once. Tests that injected
`Err` at checkpoints and expected automatic resumption conflated "reported
failure" with "crash". They now panic inside `catch_unwind`, so nothing reports
the failure.

**Strict decoders make optional fields a downgrade hazard.** A field with
`#[serde(default)]` that still serializes as `null` breaks older builds that use
`deny_unknown_fields`. Add `skip_serializing_if` and test the literal old shape
byte for byte.

**Private storage must not trust the umask.** Under `umask 0277` the probe's
owner-only file lost write access and every probe failed with `EACCES`. Restore
owner bits with `fchmod` on the created handle. User-visible directories keep
honoring the umask.

**One device is not one mount.** Bind mounts share `st_dev`, yet `rename(2)`
between them is `EXDEV`, and a same-directory probe cannot see that. Compare
`STATX_MNT_ID` when devices match. Only a real mount namespace test proves this
(`unshare --user --map-root-user --mount`). Treat a rejected query (`ENOSYS`,
`EINVAL`, and `EPERM` from seccomp) as "mount id unavailable", not as a failure,
or one sandbox refuses every durable move. An endpoint that is itself a mount
point fails `rename(2)` with `EBUSY`; compare its mount id with its parent's
before journaling. Admission must also reject a submount inside a retained
payload, because the plan validator does, and parity between the two is the
whole point.

**Give stranded records an exit that deletes nothing.** Forget
(`RecoveryChoice::Release`) removes only the record and its locks. Decide it
from durable state, because the stranded volume may be what cannot be observed.
