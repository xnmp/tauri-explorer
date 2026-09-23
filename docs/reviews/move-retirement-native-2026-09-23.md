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

The final run passes all three cases in 13.5 seconds. This is acceptance duration,
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

Type checks, code-map coverage and frontend build pass. Rust production logic is
unchanged from the separately reviewed retirement core in `eb82ab6c`.

Issue #736 remains incomplete: the real filesystem RENAME_NOREPLACE capability
probe before root intent is still required. These cases do not simulate an
unmounted volume or qualify Windows/macOS, and do not enable durable recovery by
default. Reproduction requirements are in `e2e-tauri/README.md`.
