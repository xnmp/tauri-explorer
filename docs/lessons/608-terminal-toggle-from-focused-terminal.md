# #608: Terminal toggle remains reachable from terminal focus

The terminal owns Explorer shortcuts by default, but the chord that toggles
the terminal panel is an exception because it controls that very surface.
Check its configured command-specific chord prefix and suffix in both the
xterm handler and the page handler. Retain the eligible command IDs while a
chord is active: matching a prefix alone would let unrelated Explorer chords
with the same prefix steal input from terminal-hosted applications.
When xterm accepts a mismatching suffix, cancel the pending Explorer chord at
the terminal ownership boundary; xterm may stop the event before the page
dispatcher can perform its usual chord cancellation.
