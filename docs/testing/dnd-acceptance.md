# Drag-and-drop acceptance

DnD is a core Explorer contract. A policy matrix is useful evidence about
policy, not proof that a physical gesture delivers a native Drop or moves files.
See [the #1217 transport audit](1217-dnd-coverage-audit.md) for the exact broken
baseline's 22,683 passing tests and the native red/green reproduction.

## A second demonstrated false green

The merged #1218 [native run](https://github.com/xnmp/tauri-explorer/actions/runs/38990985941)
has 145 Linux case receipts, including three passed, unskipped real DnD cases.
Its overall failure was Windows lint; the Linux suite passed. The proposed
rollback [#1224](https://github.com/xnmp/tauri-explorer/pull/1224) removes the
fix and those cases. Its [green native run](https://github.com/xnmp/tauri-explorer/actions/runs/38993755269)
contains 142 Linux receipts and **zero DnD outcomes**. Green native smoke alone
did not require core functionality to be exercised.

Other independently identified gaps:

- Four bookmark tests in `e2e/new-features.spec.ts` swallow timeouts and assert
  only if pinning already succeeded, or return if too few bookmarks exist.
- `e2e/fixtures.ts` forces Linux platform behavior in browser tests, including
  WebKit. These tests do not establish Windows/macOS source wiring.
- A Windows unit fixture invokes the HTML5 source handler, while Windows rows
  normally use the pointer-source path. A handler contract does not prove that
  the component binds that handler on the claimed platform.
- The native CI job did not forbid focused Mocha tests or reconcile discovered
  cases with required user contracts.

## Executable acceptance

`bun run test:e2e:tauri:dnd` runs only the native DnD spec.
`bun run test:e2e:tauri:dnd --full` runs the entire ordinary native suite and
requires the same DnD contracts. Both require a SHA-256-verified build manifest
from `bun run build:native:qualification`, matching the current commit (the CI
checkout SHA on Actions). Run exclusively on an isolated Xvfb/Openbox display,
private D-Bus session and private XDG profile, established before D-Bus starts.

The independent required contract list is `e2e-tauri/dnd-acceptance.ts`:

| Contract | User-visible result |
| --- | --- |
| Details / List / Tiles selection → folder | Both selected files disappear from the source; exact destination contents and visible entries survive space/hash/non-ASCII names |
| Miller → folder, Move | Directory contents move; source column and destination listing refresh |
| Miller → folder, Ctrl-copy | Source and destination retain exact contents |
| Miller modifier change after gesture start | Mid-gesture Ctrl produces Copy under the existing modifier policy |
| Escape → retry | An admitted gesture ends without mutation; a distinct next gesture moves the file and updates the listing |

Listing sources retain the existing fixed Move policy. Do not change domain
expectations simply to fill a desired test matrix cell.

Every qualification invocation owns a fresh UUID and receipt directory under
`e2e-tauri/logs/`. Acceptance requires process exit zero and exactly one passing,
unskipped receipt per required ID, from this run and the actual GTK suite.
Missing, partial, stale, duplicate, failed or malformed evidence fails. Any
other failed native case also fails a full run. Artifacts include the tested
binary hash/revision, contract outcomes, and the ordinary native driver logs.
The hook-only page observer records the actual Rust receiver Drop with its
source session; successful cases require this receipt as well as actual disk
and UI outcomes. It does not manufacture events or perform mutations.

`--negative-control` interposes GTK destination acknowledgement in that private
session. It must observe that the interposer actually ran, that a genuine
native drag was accepted without a DOM fallback, and that the filesystem
transfer assertion failed with unchanged source/destination contents. Setup
failures, skipped cases and a passing transfer cannot satisfy this control.
The Linux CI step runs this control and then positive full qualification inside
the already-required `smoke (ubuntu-latest)` status.

The independent manifest prevents accidental discovery loss. It is not
tamper-proof: removing both the tests and enforcement still requires trusted
review or protected-base policy. A PR with an old green status can also bypass
new checks when branch protection allows an out-of-date base.

## Outstanding qualification

These remain open acceptance work under #1225; do not describe them as covered
by the GTK X11 gate or by a policy test count:

| Boundary | Required evidence |
| --- | --- |
| Quick Access pin/reorder | Unconditional browser outcome assertions, followed by real native source/destination admission |
| Breadcrumb/tab/background/cross-pane destinations | One real transfer per distinct receiver adapter |
| Plugin and terminal destinations | Actual native delivery with the underlying files unchanged |
| Cross-window and external applications | Real second webview and independent provider/receiver, including source/destination contents |
| Windows | Real WebView2 pointer-source Move/Copy/Cancel outcomes on an isolated CI runner |
| macOS | Real native pointer-source outcomes through the existing Mac2 pilot |
| GNOME Wayland | Admitted private compositor modifier/cancel/transfer outcomes; Xvfb is X11 evidence only |
| Multi-file Undo | Native transfer then one Undo restores the selection's original contents |
| Publication | Qualification of the exact hook-free release artifact digest/configuration before publishing |

At audit time, `dev` requires Linux native smoke, but allows admin bypass and an
out-of-date base. Main requires a PR without required test statuses.
`release.yml` publishes after version/build without a native qualification
dependency. Debug binaries with E2E hooks do not certify shipped release bundles.

The approach follows outcome-oriented testing and deliberate negative controls;
see [Playwright's testing guidance](https://playwright.dev/docs/best-practices)
and [mutation-testing outcomes](https://stryker-mutator.io/docs/mutation-testing-elements/mutant-states-and-metrics/).
