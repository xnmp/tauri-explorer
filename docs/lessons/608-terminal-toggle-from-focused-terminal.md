# #608: Terminal toggle remains reachable from terminal focus

The terminal owns Explorer shortcuts by default, but the chord that toggles
the terminal panel is an exception because it controls that very surface.
Check its configured command-specific chord prefix in both the xterm handler
and the page handler; a generic active-chord or any-binding check would let
unrelated Explorer chords steal input from terminal-hosted applications.
