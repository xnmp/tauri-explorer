# #758: shortcut configuration is its own surface

The binding editor was appended to general Settings while the palette's
Keyboard Shortcuts command opened only a reference sheet. Give configuration a
dedicated lazy-loaded dialog, reusing the editor and its existing binding store.
Register distinct Settings and Keyboard Shortcuts commands; retain Ctrl+/ and
the reference sheet through Keyboard Shortcut Reference. Settings and the
reference sheet link directly to the editor without stacking those dialogs.

Keep new overlay ownership in dialogStore and the shared lazy-dialog host.
Unmount the recorder when its dialog closes so capture listeners and recording
state cannot swallow keys after reopening. Bound dialog size by the actual app
zoom and let editor controls wrap in small windows.

Browser acceptance verifies independent settings and binding persistence,
execution after reload, import/export/reset, search and cancel, focus and small
window containment. The old mixed form fails the same separation assertion.
