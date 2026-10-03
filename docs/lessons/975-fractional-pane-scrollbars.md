# #975 — Fractional workspace dimensions caused unnecessary scrollbar gutters

A sparse Tiles pane could show nearly full-length scrollbar thumbs even though
its files occupied only a few rows. The extra scroll owner was `PaneContainer`,
not the virtualized file list. The pane workspace has its own scrollport so
minimum-sized panes in dense layouts remain reachable.

`clientWidth` and `clientHeight` round CSS dimensions to integers. At application
zoom such as 130%, using those values as the pane tree's explicit dimensions
could exceed the actual fractional content box. Adding a classic scrollbar
changed the measured viewport again and left an unnecessary gutter. In the
817 × 1361 reproduction, WebKit lost approximately 9.7 physical pixels of width.
Chromium underfilled by approximately 0.61 pixels. File-list-only scroll/client
measurements missed the owning workspace and its fractional geometry.

Use the ResizeObserver `contentRect` binding to retain fractional CSS pixels and
exclude island borders and genuine scrollbar gutters. Apply the measured pane
geometry on the next animation frame, cancelling superseded frames and frames
on disposal. Updating descendant dimensions during observer delivery caused
WebKit's “ResizeObserver loop completed with undelivered notifications” error;
[MDN documents the observer delivery and animation-frame phases](https://developer.mozilla.org/en-US/docs/Web/API/ResizeObserver#observation_errors).

Do not hide workspace scrollbars: dense pane minima deliberately expand the
canvas beyond the window. Details column scrolling and each file view's virtual
vertical scroller also remain separate owners.

Regression coverage compares physical canvas and available workspace dimensions
at fractional zoom, since integer scroll extents alone cannot detect this bug.
It also scrolls a 500-entry directory by wheel and verifies Ctrl+End selects and
reveals its actual final file in Details, List and Tiles. Existing dense-pane,
divider, marquee and virtualization outcome tests cover the neighboring seams.
