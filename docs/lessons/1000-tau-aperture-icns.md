# Render every ICNS representation from the canonical artwork

The icon update exposed a blurry macOS retina representation in the existing
generator. Pillow writes a 1024px ICNS entry even when `append_images` omits it;
in that case it resizes the image on which `save()` was called. Our generator
called `save()` on a 16px image, so the 1024px entry was an enlarged 16px icon.

Include a directly rendered 1024px frame in `icns_sizes`. Verify the decoded
native representation, not just the separate 512px preview PNG: the latter
looked correct while the retina entry was wrong.

The tau-aperture master remains the exact approved source PNG. Generate Tauri's
platform assets in a temporary directory so its resized `icon.png` cannot
replace that source, then apply the existing Windows and macOS framing rules.
