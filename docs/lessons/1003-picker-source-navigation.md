# Picker source window and keyboard ownership

FileChooser requests supply an external parent identifier; the portal originally discarded it.
Attach the hidden, realized GTK picker surface before mapping. Wayland positioning belongs
to the compositor through xdg_foreign; monitor-center rules override source-relative placement.
Validate the handle and native GObject backend before entering backend-specific FFI.

Type-ahead selects a row without navigating on each character. Enter opens selected
folders; reset the prefix on directory/column changes. Await Modal focus restoration
before Quick Open changes the column, or the retained ancestor row can reactivate its
old column. Filter inputs and the Quick Open modal own their keyboard events.

Persist picker history before terminal picker_respond IPC: native completion closes
its webview. WebKit localStorage is cached per process, even when processes use
one WebsiteDataManager directory; refreshing localStorage cannot make history
coherent. Use granular SQLite transactions as the native authority, with legacy
localStorage imported once and maintained as an optimistic browser mirror.

Publish canonical reads synchronously inside the mutation-epoch guard; returning
an accepted snapshot across another await lets newer optimistic work race its
publication. Prune only the observed backend revision and the unchanged local
entry identity, because same-path/same-time reuse can produce equal values. Preserve
unchanged identities when rehydrating storage; compare semantic field tuples, not
JSON property insertion order. Track every inspected missing object in a Set so
duplicate legacy records are pruned together.
File picks validate current metadata kind, following valid symlinks, and delayed
validation must yield to newer selection/navigation intentions or cancellation.

Native X11 acceptance used the production helper imported by separate GTK fixture
processes on a private 1920×1080 Xvfb/Openbox display. Source bounds were
[20,40,950,650], picker bounds [45,85,900,560]; both centers were [495,365],
independently confirmed through Xlib. Specify the Xvfb screen size: this host's
xvfb-run default constrained both windows to 640×480, a vacuous equality.
The private Hyprland compositor could not render (NVIDIA linear GBM allocation),
so no visual Wayland acceptance is claimed. Hyprland v0.56.2 WindowTarget.cpp
explicitly centers a Wayland floating window on parent() when one is available.
