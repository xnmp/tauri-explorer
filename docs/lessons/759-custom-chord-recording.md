# #759: record complete chords and validate their final binding map

The old recorder saved its first non-modifier key immediately. Separate single-step
and chord recording explicitly; publish a chord only after its second step. Keep
recording/timers in an importable state controller, using the runtime deadline.

Modifier keydowns (including WebKitGTK Super/OS) and held-key repeats are not steps.
They must preserve pending runtime/recording state without renewing the deadline.
Capture-phase recording stops the page listener, so update the shared Super overlay
there and retire it on keyup. Terminal gates preserve these intermediate events
while retaining the existing command allowlist.

Logical-plus-physical fallback let one event match two distinct bindings (Q/KeyA,
£/Digit3). Capture and runtime now use exactly the identity the existing recorder saved:
physical Alt letters and shifted digits, logical other keys. US shifted-digit
string aliases normalize consistently for runtime and conflict checks. Missing
physical codes fall back to normalized logical strings. This preserves already
recorded non-US letter shortcuts and logical terminal core navigation; remove
only the alternate physical fallback that previously shadowed another binding.

Validate import against the proposed final map, not intermediate defaults: valid
swaps otherwise fail after Reset All. Recheck after rejected entries restore their
old bindings. Publish accepted imports and explicit conflict overrides atomically.
Persist explicit null unbindings; deleting an override is the separate reset action.

Regressions exercise production matcher/store contracts, exact fake-clock deadlines,
actual modifier sequences, repeats, capture cancellation, export/reset/import swaps,
and real browser navigation. Scroll proof targets into the viewport before screenshots;
a visible DOM element below the scrollport does not demonstrate a help label.

Configured Explorer chord steps must reach the matcher before fallback window
surface actions (Jobs/Settings/filter/pane/terminal). A prefix replacing such
an action requires explicit editor Override confirmation; import reports these
overrides. Derive warnings from the same window policy, never fake command IDs.
Consume unmatched non-modifier Explorer suffixes to avoid native WebView Find.
Terminal chord ownership is computed from its eligible command ID alone, so an
unrelated Explorer chord cannot suppress the terminal's default toggle.

Resolve eligible terminal command ownership before terminal-native copy/paste or
readline bytes. xterm's custom-handler false bubbles to the window owner, so the
opposite order can perform both a paste and a terminal-toggle chord. Extract the
actual adapter into terminal-key-handler.ts and verify observable clipboard/PTY
calls: eligible chord steps must perform none, unrelated/unavailable Explorer
bindings leave normal terminal clipboard and readline actions intact.
