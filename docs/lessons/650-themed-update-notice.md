# Keep update notices on shared dialog chrome

The update notice is a persistent, fixed-position surface, but it should still
use the `modal-card`, `dialog-actions`, and `btn` primitives. Keeping its
positioning local while inheriting those shared controls makes every active
theme supply the surface, border, text, accent, and button styles.

The browser regression starts with a dark theme and an available mock update,
then asserts the rendered shared classes and resolved dark dialog chrome.
