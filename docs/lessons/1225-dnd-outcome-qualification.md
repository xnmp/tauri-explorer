# #1225: Green test counts are not DnD acceptance

The #1217 policy/lifecycle suite supplied its own native events; 22,683 passing
cases could not establish that GTK would deliver a Drop. The initial fix added
three real transfer outcomes. A proposed CI rollback then deleted those tests
and returned green with zero DnD outcomes. Separately, four bookmark tests passed
with bookmark creation disabled because assertions depended on prior success.

Make required user contracts independent of test discovery. Require exact
run-bound, unskipped outcome receipts and a verified binary revision/hash.
Keep this fatal inside an already-required status, and challenge the actual
transport with a negative control that must fail for the expected filesystem
outcome, not merely fail setup. Protect the enforcement itself through review.

Expanding real gestures exposed another native resource bug: Escape cancelled
the drag, but retry never delivered pointerdown to the page. GTK cancellation
faded its drag window and relied on context finalization to destroy it. Keeping
completed source contexts strongly referenced kept the invisible input window
alive. Retain strong contexts only while live; release the completed context
outside the shared RefCell borrow, keeping immutable session/token and source
window history for delayed receiver correlation. Do not hide/ungrab the window
or add delays to mask ownership. The unchanged real cancel/retry test fails on
the old fixed binary and passes after this lifecycle correction.

Hosted macOS tests exposed a separate platform-invalid assertion: GTK source
locality was injected into a callback fixture, then its Linux-only provenance
field was expected on every OS. Keep the stale-identity and modifier contracts
active everywhere; require GTK provenance on Linux and its omission elsewhere.
Do not skip the tests or change production metadata to satisfy the fixture.

An explicit Cargo host target moves the executable below its target triple.
Every native process probe must resolve the same verified build manifest as
WebDriver; a hardcoded `target/debug` path either misses the test app or risks
targeting a different binary. Keep exact executable and isolated-profile checks.

The bundle gate also exposed timestamp noise: SvelteKit's default version changes
chunk hashes without source changes. Use the package release version for this
embedded desktop SPA. Two builds then produce identical client files and satisfy
the existing raw/gzip caps; do not raise caps or normalize measured assets.

See [the acceptance audit and outstanding boundaries](../testing/dnd-acceptance.md).
Xvfb establishes GTK X11 behavior, not Windows/macOS pointer sources, GNOME
Wayland, external-app interoperability or hook-free release artifacts.
