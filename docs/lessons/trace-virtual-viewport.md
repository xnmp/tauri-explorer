# Trace inspector and virtual viewport geometry

The responsive inspector can shrink the file collection after a keyboard jump
has already revealed its endpoint. Cursor reveal must follow the virtual view's
settled height and row geometry, including grid-column changes. Outer container
ResizeObserver ordering differs between Chromium and WebKit; DOM membership in
that callback cannot establish whether a cursor was visible before resizing.

Retain explicit navigation/focus reveal ownership and release it on manual
wheel, touch, or pointer input and directory/view changes. Column controls and
inline editors own their focus independently. Reconciliation must preserve
external focus and use the existing cancellable deferred focus request.

WebKit additionally clamps scrollTop while keyed virtual rows are replaced if
the scroll extent is represented as two changing spacers plus row contents.
Combined diagnostics showed a correct top=15850 for 16000px of content and a
150px viewport becoming 15498 during the DOM patch, before the restored total
height returned to 16000px. This is a transient extent problem, not delayed
ResizeObserver delivery. A persistent height canvas with positioned rows keeps
the scroll extent stable throughout row replacement.

Regression coverage checks endpoint visibility, Tab return to virtual cursors,
and deliberate manual scrolling across inspector/viewport changes in both
Chromium and WebKit. Shared virtualization, inline creation/rename, and backward
focus contracts also exercise the changed virtual scroller.
