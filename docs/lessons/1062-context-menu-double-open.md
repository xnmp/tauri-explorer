# 1062 — context menu appeared to fade in twice

**Symptom:** after a right-click (most visibly while another menu was open) the
menu faded in, became fully visible, then faded in again ~100 ms later (the
length of `menuIn`).

**What was ruled out:** a double mount. A MutationObserver on `.context-menu`
insertions and an `animationstart` counter show exactly one insertion and one
`menuIn` per gesture in Chromium and Playwright WebKit, in Details/List/Tiles,
with the preview pane on and two panes. The backdrop's close + rAF re-dispatch
produces one `open`, not two.

**Cause:** `ContextMenu.svelte` mounts the `.context-menu` element
`visibility: hidden` for one measuring frame (clamp effect), but `menuIn` was
bound to the element itself, so the animation started at mount, while hidden.
The reveal lands one or more frames later (>100 ms under load, in WebKit the
whole animation can elapse hidden), and the engine then spends or replays the
entrance at reveal, which reads as a second fade-in. The in-repo harness cannot
reproduce the visual replay itself, only that the animation starts while hidden
(it did in 6 of 9 single-pane cases before the fix).

**Fix:** the entrance is gated on `.context-menu.revealed` (`menuVisible`), so
the animation starts exactly when the menu becomes visible.

**Test:** `e2e/context-menu-single-open.spec.ts` asserts one insertion, one
`menuIn` start, and none while hidden, per gesture.
