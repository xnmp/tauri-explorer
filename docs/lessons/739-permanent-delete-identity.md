# #739 — permanent deletion must bind to the selected object

**Symptom.** Permanent deletion observed an entry, then removed it again by
pathname. Another process that renamed the selected entry (or an ancestor)
aside and put unrelated data at the old name got that data deleted.

**Why rechecking is not enough.** `unlinkat` has no expected-inode argument, so
a metadata recheck immediately before unlink — or `openat2` alone — still
leaves the final check-to-unlink race. Admission only excludes cooperating
Explorer mutations; it cannot stop external processes.

**Fix (Unix).** `files/permanent_delete.rs` opens the *physical* parent without
following links (Linux: search-only `O_PATH` handles, so writable-but-unreadable
parents still work), verifies its identity, creates a fresh 0700
`.tauri-delete-<random>` sibling, and atomically captures the entry with a
no-replace rename between the two handles. Identity is verified **after** the
move and **before** anything irreversible. A substitute is renamed back
(no-replace); removal is handle-relative, no-follow, never crosses a
device/mount, and keeps a constant number of descriptors by reopening `..` and
verifying the recorded identity.

**Outcome classification is by phase**, not by the first error:

| Phase | Result |
| --- | --- |
| Before capture, staging removed | ordinary failure (no effect) |
| Before capture, staging cleanup fails | uncertain, names the residue |
| Substitute captured and fully restored | ordinary failure |
| Restore blocked (name re-occupied) | uncertain, both objects kept, names residue |
| Removal fails before any unlink | restored → ordinary failure |
| Removal fails after an unlink | restored remainder → uncertain, batch suffix stops |
| Payload gone, empty staging not removed | success **with warning** |

**Testing.** Stat-only pseudo-fixes pass "replace before execute" tests. The
injectable `Operations` seam substitutes entries *inside* the rename call, at
the exact last seam; removing the post-move identity check fails three tests.

**Hardening from review.** On Linux the prepared birth time (`statx`
STATX_BTIME) must also match after capture: `utimensat` cannot forge it, so an
attacker who forces inode reuse and replicates size/mode/mtime still mismatches
where the filesystem reports btime. Staging is removed only while its name
still refers to the directory this deletion created, and a staging directory
that was created but could not be opened is removed (or reported) before an
ordinary failure is returned.

**Limits.** Not a defence against a hostile same-user process inside the
private staging directory, inode reuse, or proof of every descendant's
provenance. Crash after capture can leave a hidden `.tauri-delete-*` sibling;
it is never auto-cleaned (a recognisable name proves nothing). Windows still
removes by path with no identity guarantee; macOS uses the same Unix code
(`renameatx_np`) but has no native qualification yet, and its parent walk
needs read permission (Linux uses search-only `O_PATH`), so a writable but
unreadable parent fails closed there. Kernels without `STATX_MNT_ID` (<5.8)
fall back to device comparison, which cannot distinguish same-device bind
mounts. Descendants created or swapped by a process holding a handle inside
the captured tree are removed like `rm -rf` would; only the selected entry
and its ancestors are identity-bound. Staging adds a mkdir, rename and rmdir
per item: 5,000 files took 292 ms versus 30 ms for plain unlink (tmpfs,
release), with preparation (shared admission capture) 155 ms of that.
