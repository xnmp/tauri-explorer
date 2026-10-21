# Caretless Open action returns to the far right (#1328)

#1325 let the title shrink to its content so the caretless Open action sat
beside the folder name. Users found the moving target worse: the action now
sits at the far right again (Details: the Name cell's right edge; List: the
row's right edge). The title keeps `flex: 1; min-width: 0` and the button a
fixed `flex: 0 0 22px`, so a long name truncates before the button rather than
overlapping or clipping it. Tests assert the button's right edge against the
row (or Name cell) edge and the name's text range against its own box.
