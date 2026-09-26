# 785 — Theme contrast: measure what axe can see, and fix tokens at the source

`e2e/theme-accessibility.spec.ts` runs axe's WCAG 2.1 A/AA rules over every
built-in theme, with and without premium surfaces, in all three view modes.

## axe silently measured nothing at first

The first scan reported no contrast violations at all. `color-contrast` had
matched no nodes: `<html>` has no in-flow content (the body is absolutely
positioned), so its box is 0px tall, and axe treats every element as clipped
by it. Browsers still paint, because the root's `overflow: hidden` propagates
to the viewport. The spec now gives the root the viewport's height, and it
fails unless axe measured more than ten text nodes. A contrast rule that
matched nothing proves nothing.

## axe cannot composite everything this window paints

axe reports "incomplete" rather than a ratio for text above:

- the background-animation canvas (it cannot read pixels);
- CSS gradients, including single-colour gradient layers such as the active
  tab's `--background-card` over `--background-solid`;
- pseudo-element backgrounds (the tab overlays and the title-bar sheen).

Each is replaced by the solid colour it composites to, or removed where it
never sits behind text at a visible alpha. The title-bar sheen does sit behind
tab titles and fades from a highlight to transparent. Its two ends are opposite
worst cases: the plain bar for dark text and full strength for light text. The
spec therefore scans the title bar a second time with the sheen's strongest
stop folded in.

Chromium serialises `color-mix()` results as `color(srgb r g b / a)` with 0–1
channels, not `rgba()`. Any code that parses computed colours must accept both.

## `role="tab"` has presentational children

A close `<button>` inside `role="tab"` is a nested interactive control
(`nested-interactive`), even at `tabindex="-1"`. Moving it beside the tab puts
a non-tab in the tablist instead. The close control is now a pointer-only,
`aria-hidden` element, and the keyboard closes tabs with Ctrl+W.

## Whole-row opacity fails every theme

Empty, hidden and cut entries used to dim the whole row, which put their names
below 4.5:1. They now dim only the icon (`[data-drag-icon]`, present in all
three views) and draw the label in `--text-secondary`. Windows Explorer ghosts
the icon for the same states.

## Fixing tokens

`--text-tertiary` failed in all twelve themes, worst on selected and hovered
rows. The spec hovers one entry and selects another so both backgrounds are
measured. Each fix keeps the token's OKLCH hue and chroma and changes only
lightness, until it clears 4.6:1 against the worst measured background. Check
the hierarchy afterwards: dark and gruvbox tertiary landed within about 3% of
secondary, so their secondary was raised to keep at least a 1.2× step.

Accent, caution and critical colours are also fills (selection bars, badges,
buttons). Where a fill is too light for text, the theme defines a separate
`--accent-text` / `--system-caution-text` / `--system-critical-text`, and the
text rule falls back to the fill token. This is Fluent's accent-text versus
accent-fill split. Darkening the fill would restyle every accent surface.

The scan cannot see this rule's reach: it renders only the main window, while
about 30 dialogs and panels also used `color: var(--accent)` and the status
fills as text. Every text use now reads the `-text` variant with the fill as
fallback. `tests/themes/theme-token-contrast.test.ts` checks every theme's
text tokens against `--background-solid`, and fails if a component draws a
fill token as text directly.

States the main scan never renders need their own case: the recovery notice's
error state is reached by failing `file_recovery_subscribe` in the browser mock.
