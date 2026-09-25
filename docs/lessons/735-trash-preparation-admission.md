# Trash admission must reserve its prepared effects

A regression test held a managed copy's read claim and invoked the existing trash
selection executor. The source was removed anyway: native batch/history ownership
was not shared filesystem admission. The same admitted path now rejects the
operation before trash or source effects.

Trash has more effects than the selected source. The interoperable format pairs
an exact payload with its `.trashinfo` metadata, and mounted placement may require
a prepared fallback ([Freedesktop Trash specification](https://specifications.freedesktop.org/trash/latest/)). The resource set must include source identities,
traversed aliases, layout creation/repair, staged metadata, final metadata and
payload names for every prepared destination. Claims only on source paths are
incomplete; a write claim on the entire trash root blocks unrelated deletions.

The coordinator's revision must surround **preparation**, not just a later
recapture of its paths. `reserve_prepared` retries both the plan and its captured
claims after a managed change. Requested strings remain receipt keys; execution
uses physical paths and versions from those same observations.

Directory creation is a narrow commuting effect: exclusive mkdir or validation of
an already-created private directory, with no symlink following or permission
repair on adoption. `EnsurePrivateDirectory` permits two such preparations to
share first-use/fallback directories. Its entry scope leaves distinct payload
names independent. Existing-directory reads and explicit mode repairs retain
ordinary exclusion; an operation observing a newly materialized directory can
conservatively fail admission until its creator finishes.

The actual worker owns the admission context. Cancelling the async waiter cannot
release the claim ahead of filesystem work or capture destruction. Accepted
forward deletion still survives renderer closure through the native history
supervisor. Cleanup errors preserve confirmed receipts and exact Undo rather
than turning a completed deletion into a replayable ordinary failure.

Native test profiles must put XDG data on the same filesystem as their fixture
files. On this Arch host `/tmp` is tmpfs while `/home/chong` is a separate mount;
using a `/tmp` data profile with home-file fixtures forces mounted-trash fallback
and can fail for permissions unrelated to admission. Keep the profile isolated
on the fixture volume and retain the worktree cwd for generated screenshots.

Acceptance on Arch: 1,276 default Rust library tests passed (21 ignored), all-target
strict Clippy passed, and 373 recovery tests passed with both durable feature
flags enabled (11 ignored). Seven native debug/custom-protocol tests passed with
`e2e-renderer-recovery`: partial batch delete/Undo/Redo, exact same-path trash
identity, recreated restore parents, and native forward history ownership,
including an accepted whole child trash batch after renderer destruction. The
[first restored-item screenshot](../../screenshots/refactor/deletion-trash-admission/native-partial-delete-undo.png)
shows the actual partial-batch Undo result. Independent source review confirmed
claim coverage, revision fencing, receipt spelling and worker lifetime. No
Windows/macOS native qualification was performed for this Linux-only integration.

The full Rust suite initially failed two local-socket tests under sandboxing and
a thumbnail-cache assertion; all 1,276 tests passed on the unrestricted rerun.
The failed native setup is preserved separately from the successful home-volume
run; changing test placement did not change the deletion implementation.

Forward coverage does not imply inverse coverage: [#740](https://github.com/xnmp/tauri-explorer/issues/740)
tracks native trash/restore Undo and Redo admission. The pre-existing external
namespace race in path-based permanent deletion is [#739](https://github.com/xnmp/tauri-explorer/issues/739).
