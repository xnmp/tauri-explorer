# Permanent peek drop destinations

File and status rows in permanent peeks fell through the temporary-only row
redirect to the pane background. A native move then targeted the source parent
and did nothing. Resolve permanent rows from the live explorer projection and
expanded membership: nested files target their immediate parent, directory rows
keep their own destination, and root files retain ordinary behavior.

The shared capture handler owns redirected DOM drops and folder feedback.
Keep the unmounted-target lifetime exception exclusive to temporary peeks;
permanent delayed fallbacks must still reject navigation, collapse or replacement.
Regression coverage includes native filesystem moves in Details, List and Tiles.
