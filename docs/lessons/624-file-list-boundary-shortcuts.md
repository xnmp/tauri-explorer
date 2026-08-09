# #624: Boundary shortcuts must own selection and virtualization together

`ExplorerPane` receives window-level shortcuts, but `FileList` owns the
virtualized scroller for Details, List, and Tiles views. Handling Ctrl+Home or
Ctrl+End solely by changing explorer selection leaves an offscreen boundary
entry unmounted and lets native browser scrolling produce a different visible
state.

Route boundary selection through FileList's `scrollToEntry` seam after updating
selection. This reveals the target in the active virtualized view before focus
moves to it. Browser coverage must exercise both Ctrl+Home and Ctrl+End from an
initially unselected pane, as well as an existing selection and an empty pane,
in every view mode.
