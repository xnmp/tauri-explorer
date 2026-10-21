# Caretless Open action placement

The title wrapper consumed all remaining row width, pushing its following Open
button to the far edge. For rows with that action, let the title shrink to its
content while retaining truncation and reserving the button's width. Measure the
text range rather than a block wrapper when checking the gap in List view.

Superseded by #1328: the action is back at the row's far right edge; see
`1328-caretless-open-far-right.md`.
