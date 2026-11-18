# Native file drag rules

GNOME Wayland native drags consume keyboard events in Mutter. In-app copy intent
comes from the source connection's first `wl_keyboard` Enter/Modifiers pair after
the grab releases (`native_file_drag/wayland_intent.rs`), frozen by focus serial;
querying GTK or tracking DOM keys during the grab is stale. Keep this channel
independent of OS action negotiation and retain the result through source
completion. Missing restoration cancels the in-app drop rather than guessing a
destructive move (#1100).
