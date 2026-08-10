# #650 — Keep update notices on shared dialog chrome

The update notice used fallback variables that no built-in theme defines, so its
surface and controls fell back to light-mode colors in dark themes. It now opts
into the shared `modal-card`, `dialog-actions`, and `btn` styles, importing
`modal.css` directly because the fixed-position notice is not rendered inside
`Modal.svelte`. Its positioning remains local while the shared primitives supply
the surface, border, text, accent, and button treatments.

The browser regression starts with an available mock update in both dark and
light themes. It asserts the rendered shared classes, resolved dialog chrome,
release handoff, and preserved update-check marker before capturing the visible
notice. This checks the rendered theme seam rather than isolated CSS tokens that
may not reach the popup.
