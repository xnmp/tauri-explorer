# #1892 — Report Issue dialog overflowed small or zoomed windows

**Symptom.** In a small window (528x657 on Windows 11) the Report Issue form
filled the window edge to edge; its header and Submit/Cancel actions were out
of view.

**Cause.** Two faults in `UserReportDialog.svelte`:

1. Its bounds used raw `100vw`/`100vh`. The app applies UI zoom as a root CSS
   `zoom` (`settings.zoomLevel`, `+page.svelte`), which scales viewport units
   too, so above 100% the card was taller and wider than the window. The
   shared `.modal-card` `min-width: 360px` also widened it past a narrow window.
2. The whole `<form>` was the scroll container, so even when the card fit, the
   header and footer actions scrolled away with the long body.

**Fix.** Divide viewport units by `var(--app-zoom, 1)` as the other bounded
dialogs do (`OpenWithDialog`, `WindowTabPicker`, `ImageCropEditor`), reset
`min-width`, and make the card a fixed-chrome flex column whose `.report-body`
alone scrolls (`min-height: 0; overflow-y: auto`). The footer wraps when narrow.

**Rule.** A dialog bounded by the viewport must write
`calc(100vh / var(--app-zoom, 1) - …)`, not `100vh`, and must keep its
actions outside the scroll region. Test with `toBeInViewport` (it uses
IntersectionObserver, so it reports on-screen geometry under root zoom):
`e2e/user-report-small-window.spec.ts`.
