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

**Fix:** `.context-menu` and `.submenu` keep their acrylic blur and enter
with a `clip-path` downward reveal plus a 6 px `margin-top` slide. WebKit
repaints those on the main thread instead of compositing them, so no layer is
torn down when the reveal ends, and the real-app recordings show the wipe with
no see-through frame. (Removing the animation entirely also fixed it, but the
motion was wanted.) The main menu's reveal stays gated on `.revealed` because
the menu is mounted hidden for one measuring frame. `prefers-reduced-motion`
disables it.

**Test:** `e2e/context-menu-single-open.spec.ts` asserts, per gesture:
- one insertion;
- one entrance animation, none while hidden;
- no opacity/transform/filter animation on any menu surface or its contents;
- full opacity on every visible frame.

It fails with the old `menuIn` (`compositedAnimations: 1, translucentFrames: 2`).
Chromium cannot render the glitch itself; verify visual changes to blurred
surfaces with a frame-diffed recording of the real app.

**General rule:** on an element carrying `backdrop-filter`, or inside one,
animate only non-composited properties (clip-path, margin/inset, size).
Opacity, transform and filter animations make WebKitGTK drop the backdrop for
a frame when they end.
