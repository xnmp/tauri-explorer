# Native rename inverse admission — #749

Linux native Rename Undo/Redo now shares the entry executor and resource admission
used by forward commands. This branch depends on Trash inverse PR #750 and forward
deletion PR #741; it is not evidence of merge or release.

## Verification

- Actual native inverse adapters previously renamed despite conflicting source or
  destination claims. Both regressions failed before the fix and now pass.
- Independent review identified inconsistent parent bindings if an unmanaged alias
  changes between source/target capture. The deterministic binding regression
  failed before the added parent/leaf validation and passes afterward.
- Full Rust library suite with both durable recovery features: **1,291 passed,
  22 ignored, zero failed**. Existing same-name rename coverage caught and helped
  correct a refresh regression in the initial extraction.
- Strict all-target/all-feature Clippy and native E2E TypeScript checks pass.
- Contracts exercise disjoint work, collision/retry, physical next-direction paths
  after alias retarget, non-UTF-8/lossy-name collisions, partial batch history order,
  actual worker ownership after waiter abort, and confirmed success despite both
  context cleanup panic and retirement failure. Existing forward alias-binding and
  native uncertainty tests also run against the shared executor.
- **Seven real Arch native tests in two specs pass**: forward rename publication,
  same-name no-op preserving Redo, accepted forward work after window destruction,
  shared inverse admission, Rename Undo after child destruction followed by Redo,
  and existing exact Copy Undo/Redo lifetime coverage.
- Screenshot shows the surviving main window containing
  `destroyed-child-renamed.txt`. The native test checks exact bytes, absence of the
  original name, peer history agreement and the next Undo ID; the screenshot alone
  does not prove those history assertions.
- Independent GPT-5.6 Sol review found no remaining blocker after the binding fix.

The JSON records hashes for local raw logs, native binary and screenshot. Logs are
local provenance, not remotely available artifacts. Native history destruction is
gated before filesystem admission; the separate Rust worker test covers ownership
already acquired when its waiter is aborted. Production frontend code is unchanged.

## Boundaries

Linux resource admission is qualified here; Windows/macOS are not. This is neither
a durable rename journal nor atomic identity-conditional protection from arbitrary
external processes. The UTF-8 history model cannot retain an unrepresentable native
path: such a confirmed rename warns and does not offer an unsafe lossy opposite.
One diagnostic limit remains: a cleanup failure during pre-effect path-binding
rejection does not replace the original rejection; no filesystem effect is hidden.
Permanent deletion's external identity protection remains tracked in #739.
