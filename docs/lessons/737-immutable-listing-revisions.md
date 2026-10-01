# #737: Immutable listings should not acquire per-entry reactive signals

Virtualizing rows limits DOM work, but it does not bound the work of traversing a
deeply reactive listing. Reading every name, kind, size or path during filtering,
sorting and status aggregation can create reactive signals for the entire directory.

Directory entries already have readonly fields, and navigation, refresh and local
mutations replace the array. Keep that revision in `$state.raw`, expose it through
the existing core-state accessor, and make the array type readonly. Keep loading,
view preferences, navigation and the selection Set reactive independently. Do not
make the whole pane raw or clone on every assignment: unchanged refreshes deliberately
reuse the current array, and the raw setter must preserve that no-op identity.

Client-side regression tests matter here. SSR unit compilation does not exercise
Svelte's browser proxy machinery. The browser contract checks exact revision/entry
identity and actual rendered publication, counts and selection in all three views;
it fails when the entry accessor is reverted to deep state. Unit contracts also
verify metadata replacement, cursor resolution and unchanged refresh identity.

Measure the native app before claiming a frame-time improvement. Temporary phase
instrumentation helps attribution, but compare final builds without those hooks.
Keep native input outcomes alongside frame gaps; neither a ready marker nor a
requestAnimationFrame callback alone proves compositor presentation or input latency.
