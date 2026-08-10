# #650 — Update notice must share dialog theme tokens

The update notice used fallback variables that no built-in theme defines, so its
surface and controls fell back to light-mode colors in dark themes. It now opts
into the shared `modal-card` and `btn` styles, importing `modal.css` directly
because the notice is not rendered inside `Modal.svelte`.

The browser regression test seeds an available update and a persisted dark theme,
then asserts computed notice colors and the release handoff before capturing the
visible notice. This checks the rendered theme seam rather than isolated CSS
tokens that may not reach the popup.
