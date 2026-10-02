# #728: PDF zoom coordinates belong to the measured viewport

The embedded PDF viewer owned zoom internally, so Explorer could not preserve a centered fit or pointer anchor. The replacement keeps fit scale and bounded pan in `domain/pdf-preview.ts` and renders a detached PDF.js canvas.

Convert client coordinates using the viewport's measured rectangle and layout dimensions. Root application zoom is insufficient: fullscreen removes that scale, and dividing by it again changes a 60px drag into 40px at 150%. The actual pre-fix fullscreen regression failed for that reason.

Native acceptance checks fit/130%, pointer pan, wheel anchors, mixed page sizes and docking at 100%/150% app zoom on a private 125% Wayland output. Wheel delivery in the native suite is a DOM WheelEvent; browser Playwright separately dispatches actual device wheel input.
