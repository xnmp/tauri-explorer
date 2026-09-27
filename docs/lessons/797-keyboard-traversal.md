# 797 — Keyboard traversal: measure the ring the user sees

`e2e/keyboard-traversal.spec.ts` walks one Tab cycle over the window and
checks it region by region: title bar, sidebar, address bar, file list,
preview, status bar. Each region must be operable from the keyboard.

For every built-in theme, with and without premium surfaces, it measures each
stop in the default Details-view cycle. It also checks the roving file-entry
stop in List and Tiles. The indicator is the outline or zero-blur box-shadow
ring on the focused element. The probe checks its weakest contrast against the
element fill, the parent surface, and any differently coloured border left
exposed beside an inset outline. At most one ring side may be cut off.

## What it found

- **No themed ring.** Most controls fell back to the engine's
  `outline: auto`, whose colour is engine-defined rather than themed, and the
  explorer pane suppressed its ring completely.
  - One global `:focus-visible` rule now draws an inset
    `--focus-stroke-outer` ring.
  - The ring is inset because an outset ring inside an `overflow: hidden`
    strip loses two sides. The status bar's recovery button did.
- **Focus rings drawn with `--accent`.** A fill token is tuned for its own
  surface, not for 3:1 against every surface a focused control sits on.
  - Every focus rule now uses the focus token.
  - The tahoe and solarized-light focus strokes are darker in OKLCH
    lightness only.
  - A unit test rejects `outline: … var(--accent)` in any `:focus` rule.
- **Selected-row edges beside the focus ring.** Details and List retain a 3px
  left selection edge, while Tiles retains a 3px bottom edge. A 2px inset
  outline leaves one pixel exposed; several themes made that accent remnant
  too close to the focus stroke.
  - While an entry has keyboard focus, that exposed edge now uses the focus
    stroke and becomes a contiguous part of the indicator in all three views.
- **The preview could not be scrolled from the keyboard.** Its scroll
  container is now a labelled `region` with `tabindex="0"` (WCAG 2.1.1).
  The explorer's arrow-key handler ignores it, so the arrow keys scroll the
  preview.

## Measuring pitfalls

- **Clipping.** `<html>` has a 0px box (the body is absolutely positioned),
  so a clipping walk must stop at the body and check the window instead.
  - A Details row wider than its horizontal scroller legitimately loses its
    far side, so only two or more cut sides count as clipped.
- **Where the walk starts.** Blurring the document leaves the engine's
  sequential-focus starting point where it was, so rotate the cycle before
  comparing region order.
- **Late regions.** The status bar's recovery notice arrives with its own
  subscription. Wait for it before walking, or the forward and backward
  cycles differ.
- **Dev-server ports.** A scratch Playwright config with
  `reuseExistingServer` silently tests whatever already listens on its port,
  including another worktree's server. Check the port's owner first.
- **Address-bar suggestions.** The autocomplete pre-selects the first
  suggestion after every fetch, including the children fetched after applying
  a folder (see #702). A second Enter on a folder with subfolders descends
  instead of confirming.
- **The terminal.** The browser mock cannot spawn a terminal session,
  because `listen` needs the Tauri internals. Typed input through the toggle
  chord is covered natively by `e2e-tauri/specs/terminal-input-order.spec.ts`.
- **Native coverage.** `e2e-tauri/specs/file-list-focus.spec.ts` checks the
  real WebKitGTK path: Tab from the address bar into the file list, then
  arrow selection.
