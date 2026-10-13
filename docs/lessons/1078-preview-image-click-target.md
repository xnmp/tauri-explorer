# 1078: Preview image click enters fullscreen from the checkerboard

The click-to-fullscreen handler (#219) sat on `.preview-image-container`, the padded flex box that also draws the checkerboard. A click on that 20px padding therefore toggled fullscreen as if it had hit the picture.

The fix passes whether `event.target` is the `<img>` into `fullscreen.click`. Entering fullscreen requires the picture; leaving at fit zoom still works from any background click, as before. The `zoom-in` cursor moved from the container to `.preview-image`.

The `<img>` box matches the visible picture because the image has no explicit width or height and only `max-width`/`max-height: 100%`, so the element hugs the picture under `object-fit: contain`. Keep it that way, or the picture hit-test will drift from the visible image.
