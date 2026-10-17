# One GTK native source for an HTML5 file drag (#1217)

WebKitGTK starts its own native drag after the HTML5 `dragstart` handler. Calling
the explicit GTK drag plugin from that handler starts a competing source. The
native probe observed two contexts for one gesture: the plugin failed, its
completion retired shared provenance, and WebKit's original source could not
complete the file move. Changing the plugin's button argument did not help.
Keeping WebKit's source alive produced native Enter/Over/Drop and a real move.

Linux HTML5 sources must share the original WebKit gesture's lifecycle. Pointer
or API sources can still start an explicit native drag. Keep copy intent separate
from transport ownership: fixed Move sources do not need a keyboard snapshot;
Miller's Modifier policy still needs fresh GNOME post-grab modifier observation.

Owning the source alone is insufficient: Miller hover reached the native
receiver, but WebKit negotiated Move and then None at release, so GTK emitted
no Drop. The native filesystem receiver must also own target negotiation.
Acknowledge supported Copy transport and consume its GTK motion; the domain
still applies the source's Move or Modifier policy. Copy acknowledgment prevents
an external source from deleting its files. Non-filesystem session carriers and
ordinary DOM drags keep their existing handling. GTK documents this ownership
contract in [drag-motion](https://docs.gtk.org/gtk3/signal.Widget.drag-motion.html).

A virtualized source row can disappear without receiving DOM `dragend`. Close
that exact renderer-owned HTML5 interval on destruction and replacement, or a
later external drop of the same paths can inherit stale Move authority. Native
completion remains authoritative for an already accepted gesture; disposing a
row is distinct from observing the real drag end. Fence end-before-adopt and
old-end-after-successor interleavings using the same gesture identities.

Native receiver identity must describe the actual GTK source context. A global
latest source or a completed sequence floor cannot distinguish an unrelated
external drag of the same paths. Proven external contexts bypass renderer HTML5
inference and retain Copy policy, including while an earlier start reply is
pending. Retain GTK object identity while mapping it to monotonic context tokens;
raw pointer addresses alone can be reused after completion.

WebKit can export a multi-file URI string as one sanitized URL. The original
source widget's AFTER `drag-data-get` handler must export every verified source
URI separately; native regression filenames include spaces, `#` and Unicode.

Browser mock tests cannot prove this GTK flow. Use real filesystem outcomes and
native input on a private Xvfb display with isolated D-Bus/XDG state; verify both
source disappearance and destination contents. Check multi-selection URI export
as well as a single file, and retain native callback diagnostics only while
investigating.

GTK's [manual drag-start API](https://docs.gtk.org/gtk3/method.Widget.drag_begin_with_coordinates.html)
creates a source; it is unnecessary when the widget already owns drag startup.
Use the original widget's [source data signal](https://docs.gtk.org/gtk3/signal.Widget.drag-data-get.html)
to export the full URI selection instead of creating another source.

The [coverage audit](../testing/1217-dnd-coverage-audit.md) records the baseline
green tests, bypassed boundaries, historical checks and prevention requirements.
