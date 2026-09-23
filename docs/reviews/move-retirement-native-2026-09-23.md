# Native move retirement acceptance — Arch, 2026-09-23

Three native WebDriver cases pass against the real production move executor and
recovery IPC. Source and target fixtures are on different mounted filesystems;
the test rejects equal device IDs. There is no mock backend or injected recovery
record. See the [machine-readable provenance](move-retirement-native-2026-09-23.json)
for binary/source hashes and the retained raw log/profile paths.

- Cross-volume file overwrite: Reclaim measures and preserves both retained roots;
  explicit dialog discard removes both, leaves the source absent and destination
  bytes intact, and decreases accounting by exactly one record and its measured bytes.
- Cross-volume directory overwrite: the same contract covers descendant cleanup.
- External destination edit: Reclaim advances the native inventory revision and
  measures the record, while both retained payloads and the external destination
  bytes survive. Reinspection shows Attention with no destructive action.

The final run passes all three cases in 13.3 seconds. This is acceptance duration,
not a performance benchmark. Earlier runs corrected test assumptions about when
measurement occurs, toast interception in the driver's small default window,
and the capitalized status label. Independent review strengthened the Reclaim
completion barrier to require native revision and measurement evidence.

The confirmation now describes discarding recovery data and Undo, covering moves
that retain source data, displaced originals, or only journal authority.

Evidence:
- [Directory before discard](../../screenshots/feat/durable-move-retirement/native-directory-before-discard.png)
- [Directory after discard](../../screenshots/feat/durable-move-retirement/native-directory-after-discard.png)
- [Unresolved move preserved](../../screenshots/feat/durable-move-retirement/native-unresolved-preserved.png)

This run includes the real per-volume exclusive-rename capability preflight.
Fourteen focused contracts pass, including 30 process-kill scenarios across
successful/unsupported probes on one or two volumes. Root/file substitution and
foreign-child attacks preserve evidence even through direct Discard requests.
A production-order regression fails on the previous commit and passes here.
Independent review confirmed these tests exercise the intended boundaries.

A separate native Rust contract also passes actual unmount/remount scenarios for
both source and destination volumes. It creates a private tmpfs/bind mount inside
an isolated user/mount namespace, executes the production move, unmounts the
public endpoint, and verifies inspection/discard refusal plus surviving payload
bytes through a separate backing mount. Reattaching the same volume makes exact
explicit discard available again. This is real mount unavailability, not physical
device failure or power-loss qualification.

The full Rust library suite passes 1,303 tests (23 ignored helpers/platform tests),
then the newly added ignored mount test passes separately. The initial sandboxed
run could not bind local HTTP fixtures or satisfy the thumbnail cache assertion;
the same full suite passed outside the sandbox. Strict all-target/all-feature
Clippy, code maps and frontend build pass. Earlier type checks apply to the
unchanged frontend. Native source and executable hashes are retained in the JSON.

Windows/macOS qualification and power-loss durability are not established, and
durable recovery remains opt-in. Unknown creation windows preserve evidence;
identity verification and unlink remain separate native operations. Reproduction
requirements are in `e2e-tauri/README.md`.
