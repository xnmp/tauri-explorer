# 1062 — context menu appeared to load twice (blinked after opening)

**Symptom:** on Linux, right-clicking showed the menu, then ~100 ms later it
flickered as if it had loaded a second time.

**What was ruled out:** a double mount or a replayed animation. Instrumenting
the real WebKitGTK app (store open/close with stacks, a MutationObserver on the
menu, `animationstart`/`animationend`, per-frame computed style) showed one
open, one insertion, one reveal, one `menuIn` run, and constant style
afterwards. A first fix that only started the animation at reveal (and a
`will-change` layer-retention attempt) did not change the recording.

**Cause:** a WebKitGTK compositor glitch. Off-screen 60 fps recordings
(`wf-recorder` on a headless Hyprland output, frame-diffed) show one frame
~117 ms after opening where the menu's `backdrop-filter` surface is missing —
the menu turns see-through and unblurred — exactly when the 100 ms `menuIn`
animation ends. Variants isolated it: removing the animation or removing
`backdrop-filter` each eliminated the blink; an opacity-only animation still
blinked; animating only the menu's children kept the backdrop but flashed the
children instead. Any composited animation ending on or inside a
backdrop-filter element drops a frame.

**Fix:** `.context-menu` and `.submenu` keep their acrylic blur and appear
without an entrance animation — matching native blurred menus (macOS, GTK),
which also appear instantly.

**Test:** `e2e/context-menu-single-open.spec.ts` asserts one insertion per
gesture, no animation on any menu surface or its contents, and full opacity
from the first visible frame (it fails with `menuIn` restored). Chromium cannot
render the glitch itself; verify visual changes to blurred surfaces with a
frame-diffed recording of the real app.

**General rule:** don't animate elements that carry `backdrop-filter` (or
their descendants) in a way whose end WebKitGTK can composite late; either
drop the motion or drop the blur on that surface.
