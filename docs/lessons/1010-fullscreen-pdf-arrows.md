# #1010: fullscreen PDF arrows select rendered pages

`PdfPreview.svelte` owns PDF keyboard behavior. The shared fullscreen controller
already delegates every key except Escape to it. Route fullscreen Left/Right
through `preview.selectPage`, alongside PageUp/PageDown, before zoomed panning
or docked sibling navigation. The existing store clamps page boundaries and
publishes the page that drives both the canvas and page indicator.

The window capture listener's interactive-target exclusion alone did not preserve
focused PDF links: their events also bubble through the viewport's `onkeydown`.
Keep the exclusion in the shared handler so both delivery paths respect controls.

The browser regression uses the existing real three-page PDF and asserts canvas
center colors, page count, PDF path, selected file and fullscreen state after
arrows at fit and enlarged zoom, including both boundaries. Separate cases cover
focused links/buttons, a settings modal, page buttons, PageUp/PageDown, keyboard
zoom/reset and docked sibling navigation. Existing image/text fullscreen tests
cover their unchanged sibling behavior.

CI exposed an unstable modal-test locator: `select.first()` initially targeted
Theme, then resolved to a newly inserted language-model dropdown after its async
load. The trace showed the original Theme select handling ArrowRight and changing
the theme while the focus assertion checked another element. Target
`.color-theme-select` explicitly and keep the focus, canvas and selection
assertions; positional selectors do not preserve control identity during loading.
